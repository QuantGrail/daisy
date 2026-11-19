import { test } from "node:test";
import { stopGracefully } from "./fixtures/stop-daisy.ts";
import { commandLines, readProcTable } from "../packages/daisy/src/platform/proc-table.ts";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";
import { createApp } from "../packages/daisy/src/app.ts";
import type { AppOptions } from "../packages/daisy/src/app/context.ts";
import { OWNER_APPROVAL_TTL } from "../packages/daisy/src/approvals/approvals.ts";
import { runNode, type NodeConfig } from "../packages/daisy/src/turns/worker.ts";
import { DaisyClient, applySnapshot } from "../packages/client/src/index.ts";
import {
  api,
  LIMITS,
  type DaisyApproval,
  type Snapshot,
} from "../packages/contracts/src/index.ts";
import { runnerConfig } from "./fixtures/runner-calls.ts";

// P1-02 acceptance (总纲第 8 节, 可靠性 / 对话): R-1 … R-4 and C-4 with the
// control plane and the Runner in one process. R-1 starts the real process
// (`packages/daisy/src/main.ts`, what `npm start` runs) and kills it.

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const AGENT = resolve("tests/fixtures/agent.cjs");
const ROOT = resolve(".");

async function freePort() {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as any).port as number;
  await new Promise((r) => s.close(r));
  return port;
}

/** Windows (P5-05): the process table and command lines through Daisy's helper. */
function winProcs() {
  const t = readProcTable();
  const cmd = commandLines([...t.keys()]);
  return [...t.values()].map((r) => ({ pid: r.pid, ppid: r.ppid, command: cmd.get(r.pid) ?? r.comm }));
}
/** Every process below `pid` (ps works on Linux and macOS alike; Windows: the helper). */
function descendants(pid: number) {
  if (process.platform === "win32") {
    const all = winProcs();
    const out: typeof all = [];
    const walk = (p: number) => {
      for (const r of all)
        if (r.ppid === p && !out.includes(r)) {
          out.push(r);
          walk(r.pid);
        }
    };
    walk(pid);
    return out;
  }
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,command="], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .map((l) => {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)!;
      return { pid: Number(m[1]), ppid: Number(m[2]), command: m[3] };
    });
  const out: typeof rows = [];
  const walk = (p: number) => {
    for (const r of rows)
      if (r.ppid === p) {
        out.push(r);
        walk(r.pid);
      }
  };
  walk(pid);
  return out;
}

const until = async <T>(
  f: () => Promise<T>,
  accept: (x: T) => boolean,
  what = "state",
  tries = 150,
) => {
  let last: T | undefined;
  for (let i = 0; i < tries; i++) {
    try {
      last = await f();
      if (accept(last)) return last;
    } catch {}
    await delay(100);
  }
  throw Error(`${what} timed out: ${JSON.stringify(last)?.slice(0, 600)}`);
};

/** Answer every card (first option) until the conversation is idle. */
async function settle(c: DaisyClient, sid: string, what = "turn") {
  for (let i = 0; i < 200; i++) {
    const x = await c.snapshot(sid);
    const a = x.approvals.find((a) => a.status === "pending");
    if (a) await c.approve(sid, a.id, a.options[0].id).catch(() => {});
    else if (x.session.status === "idle" && x.items.some((i) => i.kind === "assistant"))
      return x;
    await delay(100);
  }
  throw Error(`${what} did not settle`);
}

test(
  "R-1: the process is killed mid-turn — after the restart the turn is 中断, not replayed, the history is whole",
  { timeout: 120_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "daisy-r1-"));
    const home = join(dir, "home");
    mkdirSync(home);
    const port = await freePort();
    const spawns = join(dir, "spawns.jsonl");
    // A copy of the fake CLI of this test's own: its processes are found by
    // path in the process table (other test files run theirs meanwhile).
    const agent = join(dir, "agent-r1.cjs");
    copyFileSync(AGENT, agent);
    const harness = () =>
      (process.platform === "win32"
        ? winProcs().map((r) => r.command)
        : execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).split("\n")
      ).filter((l) => l.includes(agent) && !l.includes("--version"));
    const env = {
      ...process.env,
      DAISY_DATA: join(dir, "data"),
      PORT: String(port),
      // The Runner's own state (result journal) under the test's home.
      HOME: home,
      DAISY_CLAUDE_BIN: agent,
      DAISY_CODEX_BIN: agent,
      DAISY_KIMI_BIN: agent,
      DAISY_FIXTURE_ENV_FILE: spawns,
      // The killed process's harness does not end by itself (stdin closed).
      DAISY_FIXTURE_IGNORE_EOF: "1",
    };
    const children: ChildProcess[] = [];
    const start = () => {
      const p = spawn(
        process.execPath,
        ["--import", "tsx", join(ROOT, "packages/daisy/src/main.ts")],
        { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] },
      );
      let log = "";
      p.stdout!.on("data", (d) => (log += d));
      p.stderr!.on("data", (d) => (log += d));
      children.push(p);
      return { p, log: () => log };
    };
    const url = `http://127.0.0.1:${port}`;
    try {
      const first = start();
      await until(
        () => fetch(url + "/api/health").then((r) => r.json() as any),
        (h) => h.ok === true,
        "first start",
      );
      // One process: no Runner child — only harness processes below it.
      assert.ok(
        !descendants(first.p.pid!).some((d) =>
          /services\/runner\/src\/main\.ts/.test(d.command),
        ),
      );
      // P1-03: no accounts. The command line's credential (keys/, 0600)
      // gets a one-time code (as `daisy open` does); the page trades it
      // for a web session — the channel that may answer the cards below
      // (the command line may not, T-6).
      const cli = new DaisyClient(
        url,
        readFileSync(join(dir, "data/keys/cli-credential"), "utf8").trim(),
      );
      const { code } = await cli.request("/web/open-code", "POST", {});
      const c = new DaisyClient(url, "");
      await c.webSession(code);
      // D-36: the owner sets the PIN first (install step 3); no AI turn before.
      await c.call(api.pin.pinSet, { body: { pin: "246813" } });
      const cat = await c.catalog();
      const s = await c.create({
        agent: "codex",
        title: "R-1",
        profileId: cat.profiles.find((p) => p.agent === "codex")!.id,
        workspaceId: cat.workspaces[0].id,
      });
      // A whole turn first: the history that must survive.
      await c.send(s.id, "Hello", [], "r1-hello");
      await settle(c, s.id, "first turn");
      // Then one that runs until stopped: killed under it.
      await c.send(s.id, "WAIT_UNTIL_CANCEL", [], "r1-running-turn");
      await until(
        () => c.snapshot(s.id),
        (x) => x.session.status === "running",
        "running",
      );
      await delay(500);
      assert.ok(harness().length >= 1, "a harness runs the turn");
      const before = await c.snapshot(s.id);
      first.p.kill("SIGKILL");
      await new Promise((r) => first.p.once("exit", r));
      await delay(500);
      // Killed: nobody stopped its harness, it is still there (an orphan) —
      // except on Windows (P5-05), where its Job Object ended it with Daisy.
      if (process.platform === "win32")
        await until(async () => harness().length, (n) => n === 0, "the job ends the harness with Daisy");
      else assert.ok(harness().length >= 1, "the orphan outlives the kill");
      const launches = () =>
        existsSync(spawns)
          ? readFileSync(spawns, "utf8")
              .trim()
              .split("\n")
              .filter(Boolean)
              .map((l) => JSON.parse(l))
              .filter((x) => !x.argv.includes("--version")).length
          : 0;
      const launched = launches();

      // The service manager starts it again.
      const second = start();
      await until(
        () => fetch(url + "/api/health").then((r) => r.json() as any),
        (h) => h.ok === true,
        "second start",
      );
      const after = await until(
        () => c.snapshot(s.id),
        (x) => x.session.status === "interrupted",
        "interrupted after restart",
      );
      // C-4: the next start ended what the killed process left (its
      // recorded process groups).
      await until(async () => harness(), (h) => h.length === 0, "orphans ended");
      // Not replayed: no new harness launch for it, and it stays 中断.
      await delay(2500);
      assert.equal(launches(), launched, "nothing launched again");
      const still = await c.snapshot(s.id);
      assert.equal(still.session.status, "interrupted");
      assert.ok(
        still.items.some((i) => /没有重放/.test(i.text || "")),
        "the conversation says it was cut off and not replayed",
      );
      // The history before it is whole: every item from before is there.
      for (const i of before.items)
        assert.ok(
          after.items.some((x) => x.id === i.id),
          `item ${i.id} (${i.kind}) kept`,
        );
      assert.ok(
        still.items.some((i) => i.kind === "assistant" && /Hello/.test(i.text)),
      );
      // A new message runs as usual afterwards.
      await c.send(s.id, "Hello again", [], "r1-again-turn");
      await until(
        async () => (await settle(c, s.id, "a new turn")).items,
        (items) => items.filter((i) => i.kind === "assistant").length >= 2,
        "a new turn after the restart",
      );
      // C-4 / SIGTERM: a turn running when the process is stopped ends
      // 「中断」 (not replayed), and no harness process is left.
      await c.send(s.id, "WAIT_UNTIL_CANCEL", [], "r1-stopped-turn");
      await until(
        () => c.snapshot(s.id),
        (x) => x.session.status === "running",
        "running before the stop",
      );
      await delay(300);
      assert.ok(harness().length >= 1);
      stopGracefully(second.p, join(dir, "data"));
      assert.equal(
        await new Promise((r) => second.p.once("exit", (code) => r(code))),
        0,
      );
      assert.deepEqual(harness(), [], "nothing left after SIGTERM");
      const third = start();
      await until(
        () => fetch(url + "/api/health").then((r) => r.json() as any),
        (h) => h.ok === true,
        "third start",
      );
      const stopped = await c.snapshot(s.id);
      assert.equal(stopped.session.status, "interrupted");
      assert.ok(
        stopped.items.some((i) => /服务停止.*没有重放/.test(i.text || "")),
        "the stopped turn says it was not replayed",
      );
      stopGracefully(third.p, join(dir, "data"));
      await new Promise((r) => third.p.once("exit", r));
      assert.deepEqual(harness(), []);
    } finally {
      for (const p of children) if (p.exitCode === null) p.kill("SIGKILL");
      // Only when an assertion above failed: do not leave the
      // EOF-ignoring fake CLI running on the machine.
      for (const l of harness())
        try {
          process.kill(Number(l.trim().split(/\s+/)[0]), "SIGKILL");
        } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

async function inProcess(
  config: Partial<NodeConfig> = {},
  app: Partial<AppOptions> = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "daisy-rel-"));
  const ctx = await createApp({ pinGate: false,
    workspaceHome: dir,
    workspaceRoots: [dir],
    dataDir: dir,
    ...app,
  });
  const url = await ctx.app.listen({ host: "127.0.0.1", port: 0 });
  const c = new DaisyClient(url, ctx.issueToken());
  for (const a of ["CLAUDE", "CODEX", "KIMI"])
    process.env[`DAISY_${a}_BIN`] = AGENT;
  const controller = new AbortController();
  const worker = runNode(
    {
      ...runnerConfig(ctx, join(dir, "runner.json")),
      identityRoot: join(dir, "state"),
      ...config,
    },
    controller.signal,
  );
  const cat = await c.catalog();
  const create = (agent: "claude" | "codex", title: string) =>
    c.create({
      agent,
      title,
      profileId: cat.profiles.find((p) => p.agent === agent)!.id,
      workspaceId: cat.workspaces[0].id,
    });
  return {
    ctx,
    c,
    url,
    create,
    snap: (sid: string) => c.snapshot(sid),
    async close() {
      controller.abort();
      await worker.catch(() => {});
      await ctx.app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test(
  "R-2: the same idempotency key 100 times — one turn, one result, 100 identical answers",
  { timeout: 60_000 },
  async () => {
    const f = await inProcess();
    try {
      const s = await f.create("codex", "R-2");
      const answers = await Promise.all(
        Array.from({ length: 100 }, () =>
          f.c.send(s.id, "Hello", [], "r2-same-key"),
        ),
      );
      const ids = new Set(answers.map((a) => a.id));
      assert.equal(ids.size, 1, "one id for all 100");
      assert.equal(answers.filter((a) => !a.duplicate).length, 1);
      const done = await settle(f.c, s.id, "the one turn");
      assert.equal(
        f.ctx.store.one(
          "SELECT COUNT(*) n FROM jobs WHERE session_id=?",
          s.id,
        ).n,
        1,
        "executed once",
      );
      assert.equal(
        done.items.filter((i) => i.kind === "assistant").length,
        1,
      );
      // Sent again after it finished: still the original, not a new turn.
      const late = await f.c.send(s.id, "Hello", [], "r2-same-key");
      assert.equal(late.id, [...ids][0]);
      assert.equal(late.duplicate, true);
      await delay(800);
      assert.equal(
        f.ctx.store.one(
          "SELECT COUNT(*) n FROM jobs WHERE session_id=?",
          s.id,
        ).n,
        1,
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "R-3: the live socket drops mid-stream and reconnects — the client's view catches up from its cursor, nothing lost, nothing twice",
  { timeout: 60_000 },
  async () => {
    const f = await inProcess();
    try {
      const s = await f.create("codex", "R-3");
      // The client's view: a snapshot, then deltas since its cursor on
      // every 「changed」 signal of the live socket.
      let held: Snapshot = await f.c.snapshot(s.id);
      let catching: Promise<void> = Promise.resolve();
      const catchUp = () =>
        (catching = catching.then(async () => {
          // null: nothing to merge (the held view is still current).
          held =
            applySnapshot(
              held,
              await f.c.snapshot(s.id, { since: held.cursor }),
            ) ?? held;
        }));
      const open = () =>
        new Promise<WebSocket>((ok, bad) => {
          const ws = new WebSocket(f.url.replace("http", "ws") + "/api/live");
          ws.on("error", bad);
          ws.on("message", (raw) => {
            const m = JSON.parse(String(raw));
            if (m.type === "changed" || m.type === "ready") void catchUp();
          });
          ws.on("open", () => {
            ws.send(
              JSON.stringify({ type: "subscribe", sessionId: s.id, token: f.c.token }),
            );
            ok(ws);
          });
        });
      let signals = 0;
      const a = await open();
      a.on("message", () => signals++);
      await f.c.send(s.id, "Hello", [], "r3-first-turn");
      // Mid-stream: the first signals came, then the socket drops.
      await until(async () => signals, (n) => n >= 2, "first signals");
      a.terminate();
      await catching;
      const cut = held.cursor;
      // The turn goes on (a card answered, the reply) while nobody listens.
      const full = await settle(f.c, s.id, "the turn");
      assert.ok(full.cursor > cut, "events happened while disconnected");
      // Reconnect: 「ready」 brings the delta since the held cursor.
      const b = await open();
      await until(
        async () => (await catching, held.cursor),
        (c) => c === full.cursor,
        "caught up",
      );
      b.close();
      const view = (x: Snapshot) =>
        x.items.map((i) => [i.id, i.kind, i.status ?? null, i.text]);
      // Nothing lost, nothing twice: the merged view is the server's.
      assert.deepEqual(view(held), view(full));
      const ids = held.items.map((i) => i.id);
      assert.equal(new Set(ids).size, ids.length);
      assert.equal(held.session.status, "idle");
      // Nothing new since: an empty delta at the same cursor.
      const again = await f.c.snapshot(s.id, { since: held.cursor });
      assert.equal(again.items.length, 0);
    } finally {
      await f.close();
    }
  },
);

test(
  "R-4: a card nobody answers — with the default settings it expires after 24 h, the turn ends (中断, not replayed), the session is usable again",
  { timeout: 60_000 },
  async () => {
    // limits.md §1: the default is 24 hours, written once.
    const DAY = 24 * 3600_000;
    assert.equal(LIMITS.cards.toolCardTtlMs, DAY);
    assert.equal(OWNER_APPROVAL_TTL, DAY);
    // Default settings: no per-turn limit on the Runner, no card time limit
    // given to the control plane — only its clock is the test's, so a day
    // passes at once.
    let skew = 0;
    const f = await inProcess({}, { clock: () => Date.now() + skew });
    try {
      const pending = async () =>
        (
          (await f.c.request("/approvals?status=pending")) as {
            items: DaisyApproval[];
          }
        ).items;
      const s = await f.create("codex", "R-4");
      await f.c.send(s.id, "Hello", [], "r4-card-turn");
      const waiting = await until(
        () => f.snap(s.id),
        (x) => x.approvals.some((a) => a.status === "pending"),
        "the card",
      );
      assert.equal(waiting.session.status, "waiting");
      const card = waiting.approvals.find((a) => a.status === "pending")!;
      // The 「审批」 page says when it expires: 24 h after it was raised.
      const listed = (await pending()).find((a) => a.id === `perm:${card.id}`)!;
      assert.equal(listed.expiresAt, card.createdAt + DAY);
      // A minute short of the day: still waiting (the sweep ran: listing
      // the page sweeps, and the 5 s background sweep had its chance).
      skew = DAY - 60_000;
      await pending();
      await delay(5500);
      const before = await f.snap(s.id);
      assert.equal(before.session.status, "waiting");
      assert.equal(
        before.approvals.find((a) => a.id === card.id)!.status,
        "pending",
      );
      // The day is over: no request from the test — the background sweep
      // ends the turn by itself.
      skew = DAY + 1000;
      const closed = await until(
        () => f.snap(s.id),
        (x) => x.session.status !== "waiting" && x.session.status !== "running",
        "the turn's end",
      );
      assert.equal(closed.session.status, "interrupted");
      assert.equal(
        closed.approvals.find((a) => a.id === card.id)!.status,
        "expired",
      );
      // It says why, and it is not replayed (one job, still interrupted).
      assert.ok(
        closed.items.some(
          (i) =>
            i.kind === "notice" &&
            /卡片 24 小时没人处理，已过期；本轮已中断，没有自动重放/.test(
              i.text,
            ),
        ),
        "the reason is shown",
      );
      const jobs = () =>
        f.ctx.store
          .all("SELECT status FROM jobs WHERE session_id=?", s.id)
          .map((r: any) => String(r.status));
      assert.deepEqual(jobs(), ["interrupted"]);
      // The 「审批」 page shows it as expired; answering it now is refused
      // in the conversation and on the page.
      assert.equal(
        (
          (await f.c.request("/approvals?status=all")) as {
            items: DaisyApproval[];
          }
        ).items.find((a) => a.id === `perm:${card.id}`)!.status,
        "expired",
      );
      await assert.rejects(f.c.approve(s.id, card.id, card.options[0].id));
      await assert.rejects(
        f.c.request(
          `/approvals/${encodeURIComponent(`perm:${card.id}`)}/respond`,
          "POST",
          { decision: card.options[0].id },
        ),
      );
      await delay(1500);
      assert.deepEqual(jobs(), ["interrupted"], "not replayed");
      // The session takes new work: a new turn raises a new card (the clock
      // back to now, so the new card is not a day old already).
      skew = 0;
      await f.c.send(s.id, "Hello again", [], "r4-next-turn");
      await until(
        () => f.snap(s.id),
        (x) =>
          x.approvals.some((a) => a.status === "pending" && a.id !== card.id),
        "the next turn runs",
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "C-4: closing a conversation (archive, delete) leaves no process of it behind",
  { timeout: 60_000 },
  async () => {
    const f = await inProcess();
    try {
      const harness = () =>
        descendants(process.pid).filter(
          (d) => d.command.includes(AGENT) && !d.command.includes("--version"),
        );
      for (const close of ["archive", "delete"] as const) {
        const s = await f.create("codex", `C-4 ${close}`);
        await f.c.send(s.id, "WAIT_UNTIL_CANCEL", [], `c4-close-${close}`);
        await until(
          () => f.snap(s.id),
          (x) => x.session.status === "running",
          "running",
        );
        await until(async () => harness().length, (n) => n >= 1, "a harness");
        if (close === "archive")
          await f.c.request(`/sessions/${s.id}`, "PATCH", { archived: true });
        else await f.c.request(`/sessions/${s.id}`, "DELETE");
        await until(
          async () => harness(),
          (h) => h.length === 0,
          `no process left after ${close}`,
        );
      }
    } finally {
      await f.close();
    }
  },
);
