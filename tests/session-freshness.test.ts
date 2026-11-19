import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../packages/daisy/src/app.ts";
import { translator } from "../packages/contracts/src/i18n.ts";
import { shippedPacks } from "../packages/contracts/src/i18n-node.ts";
import { setClientTranslator } from "../packages/client/src/index.ts";
// P6-23b: the client says its own messages with the host's translator (here: Chinese, as the assertions read).
setClientTranslator(translator(shippedPacks(), "zh-CN").dynamic);
import { id } from "../packages/daisy/src/store/index.ts";
import {
  applySnapshot,
  DaisyClient,
  DaisyError,
} from "../packages/client/src/index.ts";
import type { Item, Snapshot } from "../packages/contracts/src/index.ts";
import {
  aiPresence,
  ageText,
  freshnessKind,
  freshnessReducer,
  freshnessText,
  initialFreshness,
  viewFreshness,
  type Freshness,
  type FreshnessEvent,
} from "../packages/ui/src/freshness.ts";
import {
  earlierStep,
  keepPosition,
  nearTop,
  readAhead,
} from "../packages/ui/src/history-window.ts";
import { contextPlan, initialContextGate } from "../packages/ui/src/context.ts";
import { runnerReply } from "./fixtures/runner-calls.ts";
import { OWNER_ID } from "../packages/daisy/src/access/owner.ts";
import { uiLang } from "./ui-pack.ts";

// ADR-159 §8: the UI speaks Chinese in these assertions.
uiLang("zh-CN");

/**
 * fetching and knowing what is stale are two things. The server
 * answers `?since=<cursor>` with only what changed (in the client's window),
 * the live socket announces versions, the client merges deltas, and every
 * view has an explicit freshness state.
 */
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(read: () => T, accept: (x: T) => boolean) {
  for (let i = 0; i < 100; i++) {
    const x = read();
    if (accept(x)) return x;
    await delay(50);
  }
  throw Error("State timed out");
}
const item = (n: number, text = `第 ${n} 条`): Item => ({
  id: `job:item:${n}`,
  kind: n % 3 === 0 ? "user" : "assistant",
  text,
  createdAt: 1000 + n,
});

async function setup(opts: { presenceMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "daisy-fresh-"));
  const ctx = await createApp({ pinGate: false,
    workspaceHome: dir,
    workspaceRoots: [dir],
    dataDir: dir,
    ...opts,
  });
  const url = await ctx.app.listen({ host: "127.0.0.1", port: 0 });
  const owner = OWNER_ID;
  const c = new DaisyClient(url, ctx.issueToken());
  const cat = await c.catalog();
  const s = await c.create({
    agent: "codex",
    title: "freshness",
    profileId: cat.profiles.find((p) => p.agent === "codex")!.id,
    workspaceId: cat.workspaces[0].id,
  });
  // P1-03: no other accounts — a stranger is a client without the
  // owner's credential.
  const stranger = new DaisyClient(url, "");
  const put = (it: Item) => ctx.publish(s.id, "item", it, id());
  for (let n = 1; n <= 6; n++) put(item(n));
  const close = async () => {
    await ctx.app.close();
    rmSync(dir, { recursive: true, force: true });
  };
  // The local node's runner asking for work (what proves a device alive).
  const runner = JSON.parse(readFileSync(join(dir, "runner.json"), "utf8"));
  const runnerAsks = () =>
    runnerReply(ctx.runnerApi(runner.nodeId), "/claim", {}).then((r) =>
      assert.equal(r.statusCode, 200),
    );
  return { c, ctx, s, put, stranger, close, runnerAsks };
}

test("server: tail, delta since a cursor, window, total and older pages", async () => {
  const { c, ctx, s, put, stranger, close } = await setup();
  try {
    const full = await c.snapshot(s.id);
    assert.equal(full.items.length, 6);
    assert.equal(full.total, 6);
    assert.equal(full.partial, undefined);
    assert.equal(full.delta, undefined);
    // The device as the server sees it: the local node never heartbeated.
    assert.equal(full.node?.online, false);
    ctx.store.run("UPDATE nodes SET last_seen=?", Date.now());
    assert.equal((await c.snapshot(s.id, { tail: 2 })).node?.online, true);

    const tail = await c.snapshot(s.id, { tail: 2 });
    assert.deepEqual(
      tail.items.map((x) => x.id),
      ["job:item:5", "job:item:6"],
    );
    assert.equal(tail.partial, true);
    assert.equal(tail.total, 6);

    // Nothing changed: an empty delta, same cursor.
    const same = await c.snapshot(s.id, { since: full.cursor });
    assert.equal(same.delta, true);
    assert.equal(same.cursor, full.cursor);
    assert.deepEqual(same.items, []);

    // Item 2 rewritten, item 7 new: only those two, in transcript order.
    put(item(2, "改过的第 2 条"));
    put(item(7));
    const d = await c.snapshot(s.id, { since: full.cursor });
    assert.equal(d.delta, true);
    assert.deepEqual(
      d.items.map((x) => [x.id, x.text]),
      [
        ["job:item:2", "改过的第 2 条"],
        ["job:item:7", "第 7 条"],
      ],
    );
    assert.equal(d.total, 7);
    assert.ok(d.cursor > full.cursor);

    // A window starting at item 5 hears nothing about item 2.
    const w = await c.snapshot(s.id, {
      since: full.cursor,
      from: "job:item:5",
      tail: 2,
    });
    assert.deepEqual(
      w.items.map((x) => x.id),
      ["job:item:7"],
    );

    // A cursor not from this log, or a window whose first item is gone:
    // a complete (tail) answer instead.
    const future = await c.snapshot(s.id, { since: d.cursor + 1000, tail: 3 });
    assert.equal(future.delta, undefined);
    assert.equal(future.reset, true, "a cursor this log never reached: reset");
    assert.equal(future.partial, true);
    assert.equal(future.items.length, 3);
    const gone = await c.snapshot(s.id, {
      since: full.cursor,
      from: "no-such-item",
      tail: 3,
    });
    assert.equal(gone.delta, undefined);
    assert.equal(gone.reset, undefined, "a gone window start is not a reset");

    // Older pages before a held item.
    const older = await c.olderItems(s.id, "job:item:5", 2);
    assert.deepEqual(
      older.items.map((x) => x.id),
      ["job:item:3", "job:item:4"],
    );
    assert.equal(older.more, true);
    const first = await c.olderItems(s.id, "job:item:2", 5);
    assert.deepEqual(
      first.items.map((x) => x.id),
      ["job:item:1"],
    );
    assert.equal(first.more, false);
    await assert.rejects(
      c.olderItems(s.id, "no-such-item"),
      (e: any) => e instanceof DaisyError && e.status === 409,
    );

    // Transcripts stay owner-only on every new path (no credential: 401).
    for (const read of [
      () => stranger.snapshot(s.id, { since: 0 }),
      () => stranger.snapshot(s.id, { tail: 2 }),
      () => stranger.olderItems(s.id, "job:item:5"),
    ])
      await assert.rejects(
        read(),
        (e: any) => e instanceof DaisyError && e.status === 401,
      );
  } finally {
    await close();
  }
});

test("applySnapshot: replaces by id, appends, keeps unchanged objects, resets on deletions", () => {
  const session = { id: "s1" } as Snapshot["session"];
  const held: Snapshot = {
    session,
    items: [item(1), item(2), item(3)],
    approvals: [],
    cursor: 10,
    total: 5,
    partial: true,
  };
  const next = applySnapshot(held, {
    session,
    items: [item(2, "新"), item(4)],
    approvals: [],
    cursor: 12,
    total: 6,
    delta: true,
  })!;
  assert.deepEqual(
    next.items.map((x) => x.text),
    ["第 1 条", "新", "第 3 条", "第 4 条"],
  );
  assert.equal(next.items[0], held.items[0], "unchanged item keeps its object");
  assert.equal(next.items[2], held.items[2]);
  assert.equal(next.partial, true, "the window keeps its extent");
  assert.equal(next.delta, undefined);
  assert.equal(next.cursor, 12);
  // Nothing new: the same items array.
  const quiet = applySnapshot(next, {
    session,
    items: [],
    approvals: [],
    cursor: 12,
    total: 6,
    delta: true,
  })!;
  assert.equal(quiet.items, next.items);
  // An answer older than what is held is ignored.
  assert.equal(
    applySnapshot(next, { ...next, cursor: 11, delta: true, items: [] }),
    next,
  );
  // Items were deleted (rewind): the total disagrees → reload.
  assert.equal(
    applySnapshot(next, {
      session,
      items: [item(9)],
      approvals: [],
      cursor: 20,
      total: 3,
      delta: true,
    }),
    null,
  );
  // A delta with nothing held, or for another conversation → reload.
  assert.equal(applySnapshot(null, { ...next, delta: true }), null);
  assert.equal(
    applySnapshot(next, {
      ...next,
      session: { id: "s2" } as any,
      delta: true,
    }),
    null,
  );
  // A complete answer replaces.
  const replaced = applySnapshot(next, { ...next, cursor: 30, items: [] });
  assert.deepEqual(replaced!.items, []);
});

test("watchSession: tail first, push announces versions, then only deltas; older pages; rewind reloads", async () => {
  const { c, ctx, s, put, close } = await setup();
  const paths: string[] = [];
  const request = c.request.bind(c);
  c.request = ((path: string, ...rest: any[]) => {
    paths.push(path);
    return (request as any)(path, ...rest);
  }) as any;
  const views: Snapshot[] = [];
  const versions: number[] = [];
  const states: string[] = [];
  const w = c.watchSession(
    s.id,
    {
      data: (x) => views.push(x),
      version: (v) => versions.push(v),
      connection: (st) => states.push(st),
    },
    { tail: 3, pollMs: 60_000, livePollMs: 60_000 },
  );
  try {
    await until(
      () => states,
      (x) => x.includes("live"),
    );
    const first = await until(
      () => views.at(-1),
      (x) => !!x,
    );
    assert.equal(first!.partial, true);
    assert.deepEqual(
      first!.items.map((x) => x.id),
      ["job:item:4", "job:item:5", "job:item:6"],
    );
    assert.match(paths[0], /\?tail=3$/);
    const kept = first!.items[0];
    const before = views.length;
    // A new item: the socket announces the version, the fetch is a delta.
    put(item(7));
    const grown = await until(
      () => views.at(-1)!,
      (x) => x.items.length === 4,
    );
    assert.ok(views.length > before);
    assert.ok(versions.some((v) => v >= grown.cursor));
    assert.equal(grown.items[0], kept, "unchanged items keep their objects");
    assert.ok(
      paths.slice(1).every((p) => /since=\d+/.test(p) && /from=/.test(p)),
      `every later fetch is a delta: ${paths.join(" ")}`,
    );
    // Older items page in before the window.
    assert.equal(await w.older(2), true);
    assert.deepEqual(
      views.at(-1)!.items.map((x) => x.id),
      [
        "job:item:2",
        "job:item:3",
        "job:item:4",
        "job:item:5",
        "job:item:6",
        "job:item:7",
      ],
    );
    assert.equal(await w.older(5), false);
    assert.equal(views.at(-1)!.items.length, 7);
    assert.equal(views.at(-1)!.partial, false);
    // Rewind: items deleted, a notice added → the window reloads (tail).
    ctx.store.run(
      "DELETE FROM items WHERE session_id=? AND id IN ('job:item:6','job:item:7')",
      s.id,
    );
    put({
      id: "rewind-notice",
      kind: "notice",
      text: "已回退",
      createdAt: 9999,
    });
    const reloaded = await until(
      () => views.at(-1)!,
      (x) => x.items.at(-1)?.id === "rewind-notice",
    );
    assert.deepEqual(
      reloaded.items.map((x) => x.id),
      ["job:item:4", "job:item:5", "rewind-notice"],
    );
    assert.equal(reloaded.total, 6);
  } finally {
    w.close();
    await close();
  }
});

test("a session-only change (rename) reaches an open view through the push, not the poll", async () => {
  const { c, s, close } = await setup();
  const views: Snapshot[] = [];
  const states: string[] = [];
  const w = c.watchSession(
    s.id,
    { data: (x) => views.push(x), connection: (st) => states.push(st) },
    { tail: 3, pollMs: 60_000, livePollMs: 60_000 },
  );
  try {
    await until(
      () => states,
      (x) => x.includes("live"),
    );
    await until(
      () => views.at(-1),
      (x) => !!x,
    );
    await c.updateSession(s.id, { title: "改过的标题" });
    const renamed = await until(
      () => views.at(-1)!,
      (x) => x.session.title === "改过的标题",
    );
    assert.equal(renamed.items.length, 3, "the window is unchanged");
  } finally {
    w.close();
    await close();
  }
});

test("server: the page-context key covers the whole conversation, not the window", async () => {
  const { c, put, s, close } = await setup();
  try {
    assert.equal((await c.snapshot(s.id, { tail: 2 })).contextKey, null);
    const ctx = (key: string) => ({ key, label: key, text: "", refs: [] });
    put({
      ...item(10),
      id: "user:j10",
      kind: "user",
      context: ctx("page-A"),
      status: "accepted",
    } as Item);
    for (let n = 11; n < 40; n++) put(item(n));
    const tail = await c.snapshot(s.id, { tail: 3 });
    assert.ok(
      !tail.items.some((x) => x.context),
      "the window holds no context",
    );
    assert.equal(tail.contextKey, "page-A");
    // A failed message does not count; the delta carries the key too.
    put({
      ...item(41),
      id: "input:i41",
      kind: "user",
      context: ctx("page-B"),
      status: "error",
    } as Item);
    const d = await c.snapshot(s.id, {
      since: tail.cursor,
      tail: 3,
      from: tail.items[0].id,
    });
    assert.equal(d.delta, true);
    assert.equal(d.contextKey, "page-A");
    put({
      ...item(42),
      id: "user:j42",
      kind: "user",
      context: ctx("page-B"),
      status: "accepted",
    } as Item);
    assert.equal((await c.snapshot(s.id, { tail: 1 })).contextKey, "page-B");
    // The composer: 「已附带」 from the server's key, even with no such item loaded.
    const plan = contextPlan(
      ctx("page-B"),
      [],
      initialContextGate,
      "下一条",
      "page-B",
    );
    assert.equal(plan.attached, true);
    assert.equal(plan.attach, null);
    assert.equal(
      contextPlan(ctx("page-C"), [], initialContextGate, "x", "page-B").attach
        ?.key,
      "page-C",
    );
    // An older server (no key): the loaded items decide, as before.
    assert.equal(
      contextPlan(ctx("page-B"), [], initialContextGate, "x").attached,
      false,
    );
  } finally {
    await close();
  }
});

test("device presence: a runner that stops asking shows offline within the presence window, pushed to open views", async () => {
  const { c, s, close, runnerAsks } = await setup({ presenceMs: 400 });
  const views: Snapshot[] = [];
  const states: string[] = [];
  const w = c.watchSession(
    s.id,
    { data: (x) => views.push(x), connection: (st) => states.push(st) },
    { tail: 3, pollMs: 60_000, livePollMs: 60_000 },
  );
  try {
    await runnerAsks();
    await until(
      () => states,
      (x) => x.includes("live"),
    );
    // Online while its runner keeps asking.
    const keep = setInterval(() => void runnerAsks(), 100);
    await until(
      () => views.at(-1),
      (x) => x?.node?.online === true,
    );
    await delay(500);
    assert.equal(views.at(-1)!.node?.online, true);
    // Silent: offline, told through the push (polling is off).
    clearInterval(keep);
    const t0 = Date.now();
    await until(
      () => views.at(-1)!,
      (x) => x.node?.online === false,
    );
    assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
    // Back: online again.
    await runnerAsks();
    await until(
      () => views.at(-1)!,
      (x) => x.node?.online === true,
    );
  } finally {
    w.close();
    await close();
  }
});

test("reading upward: steps, read-ahead and a kept reading position", () => {
  assert.equal(nearTop(0, 800), true);
  assert.equal(nearTop(799, 800), true);
  assert.equal(nearTop(801, 800), false);
  // Held turns first, then a page from the server, then nothing.
  assert.equal(earlierStep(12, true), "show");
  assert.equal(earlierStep(0, true), "fetch");
  assert.equal(earlierStep(0, false), null);
  // Fewer than a step would stay hidden: fetch the next page meanwhile.
  assert.equal(readAhead(60, true), true);
  assert.equal(readAhead(100, true), false);
  assert.equal(readAhead(10, false), false);
  // 3000 px added above: the same distance from the end.
  assert.equal(keepPosition(9000, 6000 - 200), 3200);
  assert.equal(keepPosition(100, 500), 0);
});

test("restore: a server whose log went back replaces the held window, shown as fresh at the new version", async () => {
  // Pure merge: a reset answer replaces even with a lower cursor.
  const session = { id: "s1" } as Snapshot["session"];
  const held: Snapshot = {
    session,
    items: [item(1), item(2)],
    approvals: [],
    cursor: 100,
    total: 2,
  };
  const restored: Snapshot = {
    session,
    items: [item(1), item(3)],
    approvals: [],
    cursor: 50,
    total: 2,
    reset: true,
  };
  assert.equal(applySnapshot(held, restored), restored);
  assert.equal(
    applySnapshot(held, { ...restored, reset: undefined }),
    held,
    "without reset an older answer is still ignored (out of order)",
  );
  // Freshness: the new, lower version is the newest — fresh, not stale.
  const before = [
    { type: "data", version: 100, at: 1 },
    { type: "announce", version: 120 },
  ].reduce(freshnessReducer as any, initialFreshness) as Freshness;
  const after = freshnessReducer(before, {
    type: "data",
    version: 50,
    at: 2,
    reset: true,
  });
  assert.equal(freshnessKind(after), "fresh");
  assert.equal(after.server, 50);
  // End to end: the open view takes the restored conversation.
  const { c, ctx, s, close } = await setup();
  const views: { s: Snapshot; reset?: boolean }[] = [];
  const w = c.watchSession(
    s.id,
    { data: (x, info) => views.push({ s: x, reset: info.reset }) },
    { tail: 3, pollMs: 60_000, livePollMs: 60_000 },
  );
  try {
    const first = await until(
      () => views.at(-1),
      (x) => !!x,
    );
    // "Restore": the log and items go back to an earlier state.
    ctx.store.run(
      "DELETE FROM events WHERE session_id=? AND seq > (SELECT MIN(seq) FROM events WHERE session_id=?) + 2",
      s.id,
      s.id,
    );
    ctx.store.run(
      "DELETE FROM items WHERE session_id=? AND id IN ('job:item:5','job:item:6')",
      s.id,
    );
    w.refresh();
    const back = await until(
      () => views.at(-1)!,
      (x) => x.s.cursor < first!.s.cursor,
    );
    assert.equal(back.reset, true);
    assert.ok(!back.s.items.some((x) => x.id === "job:item:6"));
  } finally {
    w.close();
    await close();
  }
});

/** A live socket that accepts the subscription and then answers nothing (or pongs when asked to). */
async function silentServer(pong: boolean) {
  const snap = {
    session: { id: "s1", title: "t", status: "idle" },
    items: [item(1)],
    approvals: [],
    cursor: 1,
    total: 1,
  };
  const http = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(snap));
  });
  const wss = new WebSocketServer({ server: http, path: "/api/live" });
  let connections = 0;
  wss.on("connection", (socket) => {
    connections++;
    socket.on("message", (raw) => {
      const f = JSON.parse(String(raw));
      if (f.type === "subscribe")
        socket.send(JSON.stringify({ type: "ready" }));
      if (f.type === "ping" && pong)
        socket.send(JSON.stringify({ type: "pong" }));
    });
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const port = (http.address() as any).port;
  return {
    url: `http://127.0.0.1:${port}`,
    connections: () => connections,
    close: async () => {
      for (const c of wss.clients) c.terminate();
      wss.close();
      await new Promise((r) => http.close(r));
    },
  };
}

test("a socket that stops answering pings is offline within the pong deadline, then reconnects", async () => {
  const srv = await silentServer(false);
  const states: string[] = [];
  const errors: string[] = [];
  const w = new DaisyClient(srv.url, "t").watchSession(
    "s1",
    {
      data: () => {},
      connection: (st) => states.push(st),
      error: (e) => errors.push(e.message),
    },
    { pollMs: 60_000, livePollMs: 60_000, pingMs: 100, pongMs: 150 },
  );
  try {
    await until(
      () => states,
      (x) => x.includes("live"),
    );
    const t0 = Date.now();
    await until(
      () => states,
      (x) => x.at(-1) === "offline",
    );
    assert.ok(Date.now() - t0 < 1000, `${Date.now() - t0} ms`);
    assert.ok(errors.includes("连接无响应"));
    // It reconnects (and, still silent, goes offline again).
    await until(
      () => srv.connections(),
      (n) => n >= 2,
    );
  } finally {
    w.close();
    await srv.close();
  }
});

test("a socket that answers pings stays live; the browser's offline event counts at once", async () => {
  const srv = await silentServer(true);
  const g = globalThis as any;
  const listeners: Record<string, () => void> = {};
  g.addEventListener = (t: string, f: () => void) => (listeners[t] = f);
  g.removeEventListener = (t: string) => delete listeners[t];
  const states: string[] = [];
  const errors: string[] = [];
  const w = new DaisyClient(srv.url, "t").watchSession(
    "s1",
    {
      data: () => {},
      connection: (st) => states.push(st),
      error: (e) => errors.push(e.message),
    },
    { pollMs: 60_000, livePollMs: 60_000, pingMs: 100, pongMs: 150 },
  );
  try {
    await until(
      () => states,
      (x) => x.includes("live"),
    );
    await delay(700);
    assert.equal(states.at(-1), "live", states.join(" "));
    assert.equal(errors.length, 0, errors.join(" "));
    listeners.offline();
    assert.equal(states.at(-1), "offline");
    assert.ok(errors.includes("网络已断开"));
    listeners.online();
    await until(
      () => states,
      (x) => x.at(-1) === "live",
    );
  } finally {
    w.close();
    assert.equal(Object.keys(listeners).length, 0, "listeners removed");
    delete g.addEventListener;
    delete g.removeEventListener;
    await srv.close();
  }
});

/**
 * A Daisy stand-in whose log grows on demand, whose `ready` reports the
 * cursor, whose snapshot answers can be slowed, and whose "reload" closes
 * every live socket with 1012 (what a release reload does).
 */
async function reloadingServer() {
  let cursor = 3,
    answerDelay = 0,
    connections = 0;
  const items = () => Array.from({ length: cursor }, (_, i) => item(i + 1));
  const http = createServer((req, res) => {
    const at = cursor;
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          session: { id: "s1", title: "t", status: "idle" },
          items: items().slice(0, at),
          approvals: [],
          cursor: at,
          total: at,
        }),
      );
    }, answerDelay);
  });
  const wss = new WebSocketServer({ server: http, path: "/api/live" });
  wss.on("connection", (socket) => {
    connections++;
    socket.on("message", (raw) => {
      const f = JSON.parse(String(raw));
      if (f.type === "subscribe")
        socket.send(JSON.stringify({ type: "ready", cursor }));
      if (f.type === "ping") socket.send(JSON.stringify({ type: "pong" }));
    });
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(http.address() as any).port}`,
    connections: () => connections,
    /** Items written while nobody listens (no `changed` frame). */
    grow: (n: number) => (cursor += n),
    slow: (ms: number) => (answerDelay = ms),
    reload: () => {
      for (const c of wss.clients) c.close(1012, "Service restart");
    },
    close: async () => {
      for (const c of wss.clients) c.terminate();
      wss.close();
      await new Promise((r) => http.close(r));
    },
  };
}

test("reload: unconfirmed the moment the socket closes, back within ~0.5 s, live only once caught up with ready's cursor", async () => {
  const srv = await reloadingServer();
  const log: [string, any, number][] = [];
  const w = new DaisyClient(srv.url, "t").watchSession(
    "s1",
    {
      data: (x) => log.push(["data", x.cursor, Date.now()]),
      connection: (st) => log.push(["conn", st, Date.now()]),
      version: (v) => log.push(["version", v, Date.now()]),
    },
    { pollMs: 60_000, livePollMs: 60_000 },
  );
  const last = (k: string) => log.filter((e) => e[0] === k).at(-1)?.[1];
  try {
    await until(
      () => last("conn"),
      (x) => x === "live",
    );
    assert.equal(last("data"), 3);
    // The server reloads; 6 items land while nobody listens; its answers are slow.
    srv.grow(6);
    srv.slow(400);
    const t0 = Date.now();
    const mark = log.length;
    srv.reload();
    await until(
      () => last("conn"),
      (x) => x === "reconnecting",
    );
    assert.ok(Date.now() - t0 < 100, "not live from the close on");
    // Reconnects fast (first retry ~250 ms + jitter, not 2 s).
    await until(
      () => srv.connections(),
      (n) => n >= 2,
    );
    assert.ok(Date.now() - t0 < 900, `reconnected after ${Date.now() - t0} ms`);
    // `ready` says cursor 9: known stale at once, still not live…
    await until(
      () => last("version"),
      (v) => v === 9,
    );
    assert.equal(last("conn"), "reconnecting");
    // …until the catch-up answer (slowed 400 ms) holding cursor 9 is in.
    await until(
      () => last("conn"),
      (x) => x === "live",
    );
    const after = log.slice(mark);
    const live = after.findIndex((e) => e[0] === "conn" && e[1] === "live");
    const caught = after.findIndex((e) => e[0] === "data" && e[1] >= 9);
    assert.ok(caught >= 0 && caught < live, JSON.stringify(after));
    // Backoff for repeated failures: still reconnects after another reload.
    srv.slow(0);
    srv.reload();
    await until(
      () => srv.connections(),
      (n) => n >= 3,
    );
  } finally {
    w.close();
    await srv.close();
  }
});

test("viewFreshness: a view not live (closed, reconnecting, catching up) never claims fresh", () => {
  const fresh = freshnessReducer(initialFreshness, {
    type: "data",
    version: 5,
    at: 1,
  });
  assert.equal(viewFreshness(fresh, "live"), "fresh");
  assert.equal(viewFreshness(fresh, "reconnecting"), "cached");
  assert.equal(viewFreshness(fresh, "offline"), "cached");
  // The other states are what they are, live or not.
  const stale = freshnessReducer(fresh, { type: "announce", version: 9 });
  assert.equal(viewFreshness(stale, "reconnecting"), "stale");
  assert.equal(viewFreshness(initialFreshness, "reconnecting"), "loading");
  const off = freshnessReducer(fresh, { type: "fail", error: "x" });
  assert.equal(viewFreshness(off, "offline"), "offline");
  // Caught up after ready (connection live again, new data): fresh.
  const back = freshnessReducer(stale, { type: "data", version: 9, at: 2 });
  assert.equal(viewFreshness(back, "live"), "fresh");
});

test("watch (whole conversation) still delivers every item, then deltas", async () => {
  const { c, s, put, close } = await setup();
  const views: Snapshot[] = [];
  const stop = c.watch(s.id, (x) => views.push(x));
  try {
    await until(
      () => views.at(-1),
      (x) => x?.items.length === 6,
    );
    assert.equal(views.at(-1)!.partial, undefined);
    put(item(7));
    await until(
      () => views.at(-1)!,
      (x) => x.items.length === 7,
    );
  } finally {
    stop();
    await close();
  }
});

test("freshness: loading, cached, fresh, stale, offline, error — from versions, not timers", () => {
  const run = (events: FreshnessEvent[], from: Freshness = initialFreshness) =>
    events.reduce(freshnessReducer, from);
  assert.equal(freshnessKind(initialFreshness), "loading");
  assert.equal(freshnessText(initialFreshness, 0), "正在加载…");
  // A kept view shown at once is not presented as current.
  const cached = run([{ type: "cache", version: 5, at: 1000 }]);
  assert.equal(freshnessKind(cached), "cached");
  assert.equal(freshnessText(cached, 2000), "正在同步…");
  const fresh = run([{ type: "data", version: 7, at: 3000 }], cached);
  assert.equal(freshnessKind(fresh), "fresh");
  assert.equal(freshnessText(fresh, 3000), "");
  // The push says the server has v9: stale at once, before any fetch.
  const stale = run([{ type: "announce", version: 9 }], fresh);
  assert.equal(freshnessKind(stale), "stale");
  assert.equal(freshnessText(stale, 3000), "正在同步…");
  // An announcement of what it already holds changes nothing.
  assert.equal(run([{ type: "announce", version: 7 }], fresh), fresh);
  assert.equal(
    freshnessKind(run([{ type: "data", version: 9, at: 4000 }], stale)),
    "fresh",
  );
  // A cache older than what the server confirmed never wins.
  assert.equal(run([{ type: "cache", version: 3, at: 1 }], fresh), fresh);
  // Unreachable with content: offline, saying how old it is.
  const offline = run([{ type: "fail", error: "network" }], fresh);
  assert.equal(freshnessKind(offline), "offline");
  assert.equal(
    freshnessText(offline, 3000 + 3 * 60_000 + 5000),
    "离线，显示的是 3 分钟前的内容",
  );
  assert.equal(
    freshnessKind(run([{ type: "data", version: 7, at: 9000 }], offline)),
    "fresh",
  );
  // Unreachable with nothing: an error to retry.
  const failed = run([{ type: "fail", error: "暂时连不上" }]);
  assert.equal(freshnessKind(failed), "error");
  assert.equal(freshnessText(failed, 0), "暂时连不上");
  // Hidden (no longer listening): unconfirmed again.
  assert.equal(freshnessKind(run([{ type: "suspend" }], fresh)), "cached");
  assert.equal(freshnessKind(run([{ type: "reset" }], fresh)), "loading");
  assert.equal(ageText(0, 30_000), "不到 1 分钟前");
  assert.equal(ageText(0, 2 * 3600_000), "2 小时前");
});

test("aiPresence: 所在设备离线 and AI 正在上线…", () => {
  const snap = (
    patch: Partial<Snapshot["session"]>,
    items: Item[] = [],
    node = { online: true, lastSeen: 1, label: "gpu01" },
  ): Snapshot => ({
    session: { id: "s", status: "idle", ...patch } as any,
    items,
    approvals: [],
    cursor: 1,
    node,
  });
  assert.equal(aiPresence(null), null);
  assert.equal(aiPresence(snap({})), null);
  assert.equal(
    aiPresence(snap({}, [], { online: false, lastSeen: 0, label: "laptop" })),
    "device-offline",
  );
  const asked = [item(2), { ...item(3), kind: "user" as const }];
  // Queued for an AI whose process is not online: it has to come up.
  assert.equal(aiPresence(snap({ status: "queued" }, asked)), "onlining");
  assert.equal(
    aiPresence(
      snap({ status: "queued", live: { online: true, at: 1 } }, asked),
    ),
    null,
  );
  // Claimed, no output since the message yet: still starting.
  assert.equal(aiPresence(snap({ status: "running" }, asked)), "onlining");
  assert.equal(
    aiPresence(snap({ status: "running" }, [...asked, item(4)])),
    null,
  );
  assert.equal(
    aiPresence(
      snap({ status: "running", live: { online: true, at: 1 } }, asked),
    ),
    null,
  );
});
