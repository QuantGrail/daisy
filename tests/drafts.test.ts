import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_DRAFT,
  clearDraft,
  getDraft,
  setDraft,
  subscribeDraft,
  watchRun,
  type DraftRun,
} from "../packages/ui/src/drafts.ts";
import { uiLang } from "./ui-pack.ts";

// P6-22 (ADR-159 §8): the UI speaks Chinese here (the assertions are Chinese).
uiLang("zh-CN");

const run = (id: string, status = "running"): DraftRun => ({
  id,
  status,
  command: "sleep 1",
  cwd: "",
  exitCode: null,
  timedOut: false,
  output: "",
  truncated: false,
  durationMs: 0,
});
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++)
    await new Promise((r) => setTimeout(r, 5));
  assert.ok(ok());
};

test("a draft outlives the chat and stays per conversation", () => {
  assert.equal(getDraft("s-a"), EMPTY_DRAFT);
  setDraft("s-a", { text: "写到一半" });
  setDraft("s-b", { terminalMode: true });
  assert.equal(getDraft("s-a").text, "写到一半");
  assert.equal(getDraft("s-a").terminalMode, false);
  assert.equal(getDraft("s-b").terminalMode, true);
  // Stable snapshot until it changes (useSyncExternalStore).
  assert.equal(getDraft("s-a"), getDraft("s-a"));
  setDraft("s-a", (d) => ({ text: d.text + "，接着写" }));
  assert.equal(getDraft("s-a").text, "写到一半，接着写");
});

test("subscribers hear only their conversation", () => {
  let a = 0,
    b = 0;
  const offA = subscribeDraft("s-c", () => a++);
  const offB = subscribeDraft("s-d", () => b++);
  setDraft("s-c", { text: "x" });
  assert.deepEqual([a, b], [1, 0]);
  offA();
  setDraft("s-c", { text: "y" });
  assert.equal(a, 1);
  offB();
});

test("sessionStorage keeps a draft across a reload; empty drafts leave no key", () => {
  const mem = new Map<string, string>();
  (globalThis as any).window = {
    sessionStorage: {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    },
  };
  try {
    setDraft("s-e", { text: "刷新前", runs: [run("r-0", "complete")] });
    assert.ok(mem.has("daisy.draft.v1:s-e"));
    // P6-03 (ADR-153): one kept under the old harbor.* key is moved on read.
    mem.set(
      "harbor.draft.v1:s-f",
      JSON.stringify({ text: "上次留下的", terminalMode: true }),
    );
    assert.equal(getDraft("s-f").text, "上次留下的");
    assert.equal(getDraft("s-f").terminalMode, true);
    assert.deepEqual(getDraft("s-f").runs, []);
    assert.ok(mem.has("daisy.draft.v1:s-f") && !mem.has("harbor.draft.v1:s-f"));
    clearDraft("s-e");
    assert.ok(!mem.has("daisy.draft.v1:s-e"));
    assert.equal(getDraft("s-e"), EMPTY_DRAFT);
  } finally {
    delete (globalThis as any).window;
  }
});

test("a run keeps being polled after the chat is gone, once per run", async () => {
  let calls = 0;
  const client = {
    async shellStatus(id: string) {
      calls++;
      return calls < 3
        ? run(id)
        : { ...run(id, "complete"), exitCode: 0, output: "done" };
    },
  };
  setDraft("s-g", { runs: [run("r-1")] });
  watchRun(client, "s-g", "r-1", { intervalMs: 1 });
  watchRun(client, "s-g", "r-1", { intervalMs: 1 }); // remount: no second poller
  await until(() => getDraft("s-g").runs[0].status === "complete");
  assert.equal(getDraft("s-g").runs[0].output, "done");
  assert.equal(calls, 3);
});

test("a run the server no longer knows ends as an error", async () => {
  const client = {
    async shellStatus(): Promise<DraftRun> {
      throw Object.assign(new Error("gone"), { status: 404 });
    },
  };
  setDraft("s-h", { text: "留着", runs: [run("r-2")] });
  watchRun(client, "s-h", "r-2", { intervalMs: 1 });
  await until(() => getDraft("s-h").runs[0].status === "error");
  assert.equal(getDraft("s-h").runs[0].error, "等不到执行结果");
  assert.equal(getDraft("s-h").text, "留着");
});
