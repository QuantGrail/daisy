import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ResultJournal } from "../packages/daisy/src/turns/result-journal.ts";
import { openDatabase } from "../packages/daisy/src/store/open.ts";
import { isolatedWorkspace } from "../packages/daisy/src/turns/worktrees.ts";
test("parallel Git worktrees preserve divergent changes without a Daisy workspace lease", async () => {
  const root = mkdtempSync(join(tmpdir(), "daisy-workspace-")),
    src = join(root, "repo");
  mkdirSync(src);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", src, ...args], { stdio: "pipe" });
  try {
    git("init");
    writeFileSync(join(src, "answer.txt"), "base");
    git("add", ".");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@localhost",
      "commit",
      "-m",
      "base",
    );
    const signal = new AbortController().signal;
    const [a, b] = await Promise.all([
      isolatedWorkspace(src, "session-a", signal),
      isolatedWorkspace(src, "session-b", signal),
    ]);
    writeFileSync(join(a.path, "answer.txt"), "A");
    writeFileSync(join(b.path, "answer.txt"), "B");
    assert.equal(readFileSync(join(src, "answer.txt"), "utf8"), "base");
    assert.equal(
      (await isolatedWorkspace(src, "session-a", signal)).path,
      a.path,
    );
    assert.equal(readFileSync(join(a.path, "answer.txt"), "utf8"), "A");
    writeFileSync(join(src, "answer.txt"), "uncommitted");
    await assert.rejects(isolatedWorkspace(src, "session-c", signal), /未提交/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("result journal survives restart with original event identities and terminal status", () => {
  const root = mkdtempSync(join(tmpdir(), "daisy-result-"));
  try {
    // P1-02b: the journal is in daisy.sqlite; a restart reopens that file.
    let db = openDatabase(root).db;
    let j = new ResultJournal(db, "node");
    j.start("job", "lease");
    j.event("job", { id: "event", type: "item", data: { text: "answer" } });
    j.finish("job", { status: "idle" });
    db.close();
    db = openDatabase(root).db;
    j = new ResultJournal(db, "node");
    assert.equal(j.pending()[0].lease, "lease");
    assert.equal(j.evidence("job")[0].id, "event");
    assert.equal(JSON.parse(j.pending()[0].result).status, "idle");
    if (process.platform !== "win32") assert.equal(statSync(join(root, "daisy.sqlite")).mode & 0o777, 0o600);
    // Another node's journal is its own.
    assert.deepEqual(new ResultJournal(db, "other").pending(), []);
    j.ack(["event"]);
    j.remove("job");
    assert.equal(j.pending().length, 0);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("chunk recovery survives lost acknowledgment and quarantines a rejected receipt without starving new work", async () => {
  const { recoverJournal } =
    await import("../packages/daisy/src/turns/result-journal.ts");
  const root = mkdtempSync(join(tmpdir(), "daisy-result-replay-")),
    journal = new ResultJournal(openDatabase(root).db, "node");
  try {
    journal.start("one", "lease-one");
    for (let n = 0; n < 25; n++)
      journal.event("one", {
        id: "event-" + n,
        type: "item",
        data: { text: "evidence" },
      });
    journal.finish("one", { status: "idle" });
    journal.start("rejected", "old-lease");
    journal.finish("rejected", { status: "idle" });
    const received = new Set<string>();
    let lose = true,
      finals = 0;
    const send = async (id: string, _lease: string, body: any) => {
      if (id === "rejected")
        throw Object.assign(Error("old receipt"), { status: 403 });
      for (const e of body.events) received.add(e.id);
      if (lose) {
        lose = false;
        throw Error("lost ACK");
      }
      if (body.final) {
        finals++;
        return { recorded: true };
      }
      return { chunkReceived: true };
    };
    await recoverJournal(journal, new Set(), send);
    assert.equal(journal.evidence("one").length, 25);
    await recoverJournal(journal, new Set(), send);
    assert.equal(journal.evidence("one").length, 5);
    await recoverJournal(journal, new Set(), send);
    assert.equal(received.size, 25);
    assert.equal(finals, 1);
    assert.equal(journal.pending().length, 0);
    assert.ok(
      journal.db
        .prepare("SELECT blocked FROM runner_journal_jobs WHERE id=?")
        .get("rejected"),
    );
  } finally {
    journal.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
