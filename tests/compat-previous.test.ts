import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "../packages/daisy/src/app.ts";
import { hash } from "../packages/daisy/src/store/index.ts";

// Compatibility with the previous release, for real (review 2026-10-31):
//  - during a switch and after a rollback the previous release's
//    code runs on a database this code migrated. Its core write paths must
//    work there (audit, sessions, jobs, runner events and
//    completion; P1-01: 群聊 is gone from this code). This catches additive-but-breaking changes the
//    regex pre-check (schema-compat.test.ts) cannot see: a new UNIQUE index,
//    a CHECK, a trigger that RAISEs, a NOT NULL without default.
// DAISY_COMPAT_BASE picks the previous release (default: where this branch
// left origin/main).

const REPO = resolve(".");
function baseCommit(): string | null {
  try {
    const ref =
      process.env.DAISY_COMPAT_BASE ||
      execFileSync("git", ["-C", REPO, "merge-base", "HEAD", "origin/main"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    return execFileSync(
      "git",
      ["-C", REPO, "rev-parse", "--verify", `${ref}^{commit}`],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
  } catch {
    return null;
  }
}
const BASE = baseCommit();
/**
 * Where a release keeps the control plane's code: packages/daisy/src since
 * P1-02b, services/server/src before it.
 */
function layout(commit: string): string {
  try {
    execFileSync("git", ["-C", REPO, "cat-file", "-e", `${commit}:packages/daisy/src/app.ts`], {
      stdio: "ignore",
    });
    return "packages/daisy/src";
  } catch {
    return "services/server/src";
  }
}
/**
 * P1-04 (D-06, ADR-108): a release from before the clean start (no
 * store/schema.ts) is the old system — it never runs on a Daisy database
 * (it opens harbor.sqlite; a data directory with that is refused). The
 * check runs again once the previous release is a Daisy one (or with
 * DAISY_COMPAT_BASE set to one).
 */
function cleanStartBase(commit: string | null): boolean {
  if (!commit) return false;
  try {
    execFileSync(
      "git",
      ["-C", REPO, "cat-file", "-e", `${commit}:${layout(commit)}/store/schema.ts`],
      { stdio: "ignore" },
    );
    return false;
  } catch {
    return true;
  }
}
const OLD_SYSTEM = cleanStartBase(BASE);
/**
 * P1-03 (ADR-110): single owner changed step 1 itself (no database had
 * been built with it yet) — a release from before it (no access/guard.ts)
 * expects `users` / `tokens` and never runs on a single-owner database.
 */
function beforeSingleOwner(commit: string | null): boolean {
  if (!commit) return false;
  try {
    execFileSync(
      "git",
      ["-C", REPO, "cat-file", "-e", `${commit}:${layout(commit)}/access/guard.ts`],
      { stdio: "ignore" },
    );
    return false;
  } catch {
    return true;
  }
}
const BEFORE_SINGLE_OWNER = beforeSingleOwner(BASE);
let previous: Promise<{ dir: string; createApp: typeof createApp }> | null =
  null;
/** The previous release's code (git archive), sharing this checkout's dependencies. */
function previousRelease() {
  previous ??= (async () => {
    const dir = mkdtempSync(join(tmpdir(), "daisy-prev-"));
    execFileSync("sh", [
      "-c",
      'git -C "$0" archive "$1" | tar -x -C "$2"',
      REPO,
      BASE!,
      dir,
    ]);
    symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"));
    const mod = await import(join(dir, layout(BASE!), "app.ts"));
    return { dir, createApp: mod.createApp as typeof createApp };
  })();
  return previous;
}

test(
  `previous release (${BASE?.slice(0, 7) ?? "?"}) writes on a database migrated by this code`,
  {
    skip:
      (!BASE && "no base commit (DAISY_COMPAT_BASE / origin/main)") ||
      (OLD_SYSTEM &&
        "the previous release predates P1-04: the old system never runs on a Daisy database (D-06, ADR-108)") ||
      (BEFORE_SINGLE_OWNER &&
        "the previous release predates P1-03: step 1 changed before any database was built with it (ADR-110)"),
    timeout: 120_000,
  },
  async () => {
    const prev = await previousRelease();
    const data = mkdtempSync(join(tmpdir(), "daisy-compat-"));
    const opts = {
      pinGate: false,
      dataDir: data,
      projectDir: data,
      workspaceHome: data,
      workspaceRoots: [data],
    };
    // This code creates and migrates the database, and writes on it.
    const now = await createApp(opts);
    // P1-03: one owner; a web session of hers.
    const ours = { authorization: `Bearer ${now.issueToken()}` };
    const nowCat = (
      await now.app.inject({
        method: "GET",
        url: "/api/catalog",
        headers: ours,
      })
    ).json();
    const claude = nowCat.profiles.find((p: any) => p.agent === "claude");
    const s1 = (
      await now.app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: ours,
        payload: {
          agent: "claude",
          profileId: claude.id,
          workspaceId: nowCat.workspaces[0].id,
        },
      })
    ).json();
    assert.equal(
      (
        await now.app.inject({
          method: "POST",
          url: `/api/sessions/${s1.id}/messages`,
          headers: ours,
          payload: { text: "from new code", requestId: randomUUID() },
        })
      ).statusCode,
      200,
    );
    // P1-02: this code issues no node token (its Runner is in process);
    // a previous release from before P1-02 needs one — set it by hand.
    const token = "compat-node-token-" + randomUUID();
    const nodeId = JSON.parse(
      readFileSync(join(data, "runner.json"), "utf8"),
    ).nodeId;
    now.store.run("UPDATE nodes SET token_hash=? WHERE id=?", hash(token), nodeId);
    await now.app.close();

    // The previous release on that database: its own start-up, then its core writes.
    const old = await prev.createApp(opts);
    try {
      const h = { authorization: `Bearer ${old.issueToken()}` };
      const call = async (
        method: string,
        url: string,
        payload?: unknown,
        headers: Record<string, string> = h,
      ) => {
        const r = await old.app.inject({
          method: method as any,
          url,
          headers,
          ...(payload === undefined ? {} : { payload: payload as any }),
        });
        assert.ok(
          r.statusCode < 300,
          `${method} ${url} → ${r.statusCode} ${r.body.slice(0, 300)}`,
        );
        return r.json();
      };
      const cat = await call("GET", "/api/catalog");
      const s2 = await call("POST", "/api/sessions", {
        agent: "claude",
        profileId: cat.profiles.find((p: any) => p.agent === "claude").id,
        workspaceId: cat.workspaces[0].id,
        requestId: randomUUID(),
      });
      await call("POST", `/api/sessions/${s2.id}/messages`, {
        text: "from old code",
        requestId: randomUUID(),
      });
      // Its runner path: the job queued by this code, events, completion —
      // over HTTP with the node token before P1-02, in process after.
      const R: Record<string, string> = { authorization: `Bearer ${token}` };
      const inProcess = (old as any).runnerApi?.(nodeId);
      const runner = async (path: string, body: unknown, lease?: string) =>
        inProcess
          ? inProcess(path, body, lease)
          : call(
              "POST",
              `/api/runner${path}`,
              body,
              lease ? { ...R, "x-lease": lease } : R,
            );
      await runner(inProcess ? "/sync" : "/heartbeat", {
        capabilities: { filesystem: { home: data, roots: [data] } },
      });
      const claimed = await runner("/claim", {});
      assert.ok(claimed.job, "the old code claims the job this code queued");
      const lease = claimed.job.lease;
      await runner(
        `/jobs/${claimed.job.id}/events`,
        {
          events: [
            {
              id: randomUUID(),
              type: "item",
              data: {
                id: `${claimed.job.id}:a`,
                kind: "assistant",
                text: "ok",
                status: "done",
              },
            },
          ],
        },
        lease,
      );
      await runner(
        `/jobs/${claimed.job.id}/complete`,
        { status: "idle" },
        lease,
      );
    } finally {
      await old.app.close();
    }
    // And this code again on what the old code wrote (re-upgrade).
    const again = await createApp(opts);
    const snap = (
      await again.app.inject({
        method: "GET",
        url: `/api/sessions/${s1.id}`,
        headers: { authorization: `Bearer ${again.issueToken()}` },
      })
    ).json();
    assert.ok(
      snap.items.some((i: any) => i.kind === "assistant" && i.text === "ok"),
    );
    await again.app.close();
    rmSync(data, { recursive: true, force: true });
  },
);
// P1-02: 「this Runner works against the previous control plane」 went away —
// the Runner and the control plane are one process, never two versions.
