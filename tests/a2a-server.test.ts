/**
 * P4-04 A2A 服务端 (总纲 5.8, D-16, D-26, D-27, 5.11, a2a-usage.md,
 * ADR-123): over real HTTP, both transports. A is a running Daisy
 * (createApp, listening on 127.0.0.1); B and D are contacts (B on the
 * whitelist, D not), C a stranger — each signs its own cross-Daisy tokens
 * (a fresh one per request: P4-01 review, a token is good once).
 *
 * A's agents come from a fixture resolver and a fixture executor (P4-05
 * / P4-06 / P4-07 register the real ones): 研究助手 public, 代码助手
 * public but only for listed people, 私人助手 private. The executor
 * answers by the message's first word (echo / ask / slow / history / mode).
 *
 * Refusals first; then A-5, A-6, A-14, A-15, A-16; blocking (D-26);
 * authorization (pending → AUTH_REQUIRED, T-5 revocation); restart;
 * unsupported operations; and a client we did not write (@a2a-js/sdk).
 *
 * P5-02 (7.6 「经中转再跑一遍，结果相同」): with DAISY_TEST_A2A_VIA=relay
 * (tests/a2a-server-via-relay.test.ts) every call goes through the relay
 * program (P5-01, in process, `relay.test`) to A's relay address instead;
 * the same assertions, except that the owner's and the AI's local
 * credentials are not recognised there at all (401, not 403: ADR-101), and
 * the relay's own per-source rate limits (P5-01's) are raised.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { api } from "../packages/contracts/src/api/index.ts";
import { fillPath, type AnyRoute } from "../packages/contracts/src/index.ts";
import { A2A_EXT, jsonDepth, jsonTextDepth } from "../packages/contracts/src/a2a.ts";
import { InvokeError, type AgentInfo } from "../packages/daisy/src/invoke/invoke-access.ts";
import type { A2AJob, A2AOutcome } from "../packages/daisy/src/a2a/executors.ts";
import { daisy, runningTurn, type Daisy } from "./fixtures/daisy-with-issuer.ts";
import { peerDaisy, type PeerDaisy } from "./fixtures/peer-daisy.ts";
import { relayFetch, testRelay, until as untilRelay, type TestRelay } from "./fixtures/relay-net.ts";

/** P5-02: run through the relay (A's relay address) instead of A's listener. */
const VIA_RELAY = process.env.DAISY_TEST_A2A_VIA === "relay";
let relayNet: TestRelay | null = null;
const viaRelayFetch = relayFetch();
after(async () => {
  await relayNet?.stop();
});
const RELAY_TEST_LIMITS = {
  newConnectionsPerIpPerSec: 10_000,
  newConnectionsPerIpBurst: 10_000,
  ownRequestsPerIpPerSec: 10_000,
  ownRequestsPerIpBurst: 10_000,
  opensPerDaisyPerSec: 10_000,
  opensPerDaisyBurst: 10_000,
  maxPendingPerDaisy: 64,
};

const AGENTS: Record<string, AgentInfo> = {
  research: { id: "research", kind: "public", name: "研究助手", sessionId: null },
  code: { id: "code", kind: "public", name: "代码助手", sessionId: null },
  secret: { id: "secret", kind: "private", name: "私人助手", sessionId: null },
};

/** The fixture executor: what each task was asked, released by hand when "slow". */
function fixtureExecutor() {
  const runs: A2AJob[] = [];
  const gates = new Map<string, () => void>();
  const aborted: string[] = [];
  const executor = {
    async run(job: A2AJob): Promise<A2AOutcome> {
      runs.push(job);
      // The caller's answer to "ask": the first message says what it was.
      const [word, ...rest] = (job.continuing ? job.thread[0]!.text : job.text).split(" ");
      switch (word) {
        case "echo":
          return { state: "completed", answer: rest.join(" ") };
        case "ask":
          if (!job.continuing) return { state: "input-required", question: "什么颜色？" };
          return { state: "completed", answer: `颜色是 ${job.text}；之前问的是 ${job.thread[0]!.text}` };
        case "slow":
          await new Promise<void>((resolve) => {
            gates.set(job.taskId, resolve);
            job.signal.addEventListener("abort", () => {
              aborted.push(job.taskId);
              resolve();
            });
          });
          return { state: "completed", answer: "慢的做完了" };
        case "history":
          return {
            state: "completed",
            answer: JSON.stringify({
              history: job.history.map((h) => [h.request, h.answer]),
              references: job.references.map((h) => [h.request, h.answer]),
            }),
          };
        case "mode":
          return { state: "completed", answer: job.mode };
        case "files":
          return {
            state: "completed",
            answer: `收到 ${job.files.length} 个文件`,
            files: [{ filename: "out.txt", mediaType: "text/plain", bytes: Buffer.from("hello") }],
          };
        case "loop":
          return { state: "input-required", question: "还有吗？" };
        case "boom":
          throw new Error("executor exploded with secret details");
        default:
          return { state: "completed", answer: `?${job.text}` };
      }
    },
  };
  /** Wait until the slow task `id` is running, then let it finish. */
  const release = async (id?: string) => {
    for (let i = 0; i < 200 && !(id ? gates.has(id) : gates.size); i++) await new Promise((r) => setTimeout(r, 10));
    const k = id ?? [...gates.keys()][0]!;
    gates.get(k)?.();
    gates.delete(k);
  };
  return { executor, runs, gates, aborted, release };
}

async function setup(o: { dir?: string } = {}) {
  // The relay's own per-source rate limits are P5-01's (its tests); here every caller is 127.0.0.1.
  if (VIA_RELAY) relayNet ??= await testRelay(RELAY_TEST_LIMITS);
  const a = await daisy({ ...(o.dir ? { dir: o.dir } : {}), ...(VIA_RELAY ? { relay: relayNet!.daisyOptions } : {}) });
  const b = await peerDaisy("B");
  const c = await peerDaisy("C");
  const d = await peerDaisy("D");
  const fx = fixtureExecutor();
  register(a, fx);
  for (const p of [b, d]) {
    const r = await a.ctx.app.inject({
      method: "POST",
      url: api.contacts.contactImport.path,
      headers: a.withPin(),
      payload: { card: p.text, ...(p === b ? { whitelist: true } : {}) },
    });
    assert.equal(r.statusCode, 200, r.body);
  }
  // 代码助手: only D.
  const set = await a.ctx.app.inject({
    method: "PUT",
    url: fillPath(api.invoke.audienceSet.path, { aid: "code" }),
    headers: a.withPin(),
    payload: { openTo: "listed", listed: [d.card.id] },
  });
  assert.equal(set.statusCode, 200, set.body);
  await a.ctx.app.listen({ host: "127.0.0.1", port: 0 });
  const port = (a.ctx.app.server.address() as any).port as number;
  let root = `http://127.0.0.1:${port}`;
  if (VIA_RELAY) {
    const on = await a.ctx.app.inject({ method: "PUT", url: api.relay.relaySet.path, headers: a.withPin(), payload: { url: relayNet!.url, acme: false } });
    assert.equal(on.statusCode, 200, on.body);
    const st = await untilRelay(
      async () => (await a.ctx.app.inject({ url: api.relay.relayShow.path, headers: a.asCli })).json(),
      (x: any) => x.state === "connected",
    );
    root = st.address;
  }
  const close = async () => {
    await a.close();
    for (const p of [b, c, d]) p.close();
  };
  return { a, b, c, d, fx, root, port, close, ...client(a, root) };
}

function register(a: Daisy, fx: ReturnType<typeof fixtureExecutor>) {
  a.ctx.access.invoke.agents.add((id) => AGENTS[id] ?? null);
  a.ctx.a2a.executors.add((agent) => (AGENTS[agent.id] ? fx.executor : null));
  a.ctx.a2a.directory.add(() => Object.keys(AGENTS));
}

const V = { "a2a-version": "1.0" };

/** Requests as a caller would make them (a fresh token each time). */
function client(a: Daisy, root: string) {
  async function req(
    who: PeerDaisy | string | null,
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = V,
  ) {
    const token = who === null ? null : typeof who === "string" ? who : await who.token(a.urn);
    const r = await (VIA_RELAY && root.startsWith("https://") ? viaRelayFetch : fetch)(root + path, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: r.status, json, text, headers: r.headers };
  }
  let seq = 0;
  const mid = () => `msg-${Date.now()}-${++seq}`;
  const msg = (text: string, more: Record<string, unknown> = {}) => ({
    messageId: mid(),
    role: "ROLE_USER",
    parts: [{ text }],
    ...more,
  });
  /** HTTP+JSON SendMessage. */
  const send = (who: PeerDaisy, aid: string, message: any, configuration: any = {}, headers: Record<string, string> = V) =>
    req(who, "POST", `/a2a/${aid}/message:send`, { message, configuration }, headers);
  /** JSON-RPC call. */
  let rid = 0;
  const rpc = (who: PeerDaisy | string | null, aid: string, method: string, params: unknown, headers: Record<string, string> = V) =>
    req(who, "POST", `/a2a/${aid}/jsonrpc`, { jsonrpc: "2.0", id: ++rid, method, params }, headers);
  return { req, send, rpc, msg, mid };
}

/** A google.rpc.Status's ErrorInfo reason. */
const reasonOf = (j: any) => j?.error?.details?.find((x: any) => x["@type"]?.endsWith("ErrorInfo"))?.reason;
/** A JSON-RPC error's ErrorInfo reason. */
const rpcReasonOf = (j: any) => j?.error?.data?.find((x: any) => x["@type"]?.endsWith("ErrorInfo"))?.reason;
const count = (a: Daisy, table: string) => a.ctx.store.one(`SELECT COUNT(*) n FROM ${table}`).n as number;
const cardsRaised = (a: Daisy) => count(a, "invoke_requests") + count(a, "event_outbox") + count(a, "notification_events");

// ── refusals first ────────────────────────────────────────────────────────

test("who may knock: no token, a stranger, a replayed or wrongly addressed token → 401; the owner and the AI → 403; no daisy:invoke → 403 — A2A-shaped in both transports", async () => {
  const s = await setup();
  try {
    const { a, b, c, req, rpc, send, msg } = s;
    const before = cardsRaised(a);
    // Nobody: 401 with WWW-Authenticate, google.rpc.Status / JSON-RPC error.
    for (const r of [
      await req(null, "GET", "/a2a/research/.well-known/agent-card.json"),
      await req(null, "POST", "/a2a/research/message:send", { message: msg("echo hi") }),
      await req(c, "POST", "/a2a/research/message:send", { message: msg("echo hi") }),
      await req(c, "GET", "/a2a"),
    ]) {
      assert.equal(r.status, 401, r.text);
      assert.match(String(r.headers.get("www-authenticate")), /invalid_token/);
      assert.equal(r.json.error.code, 401);
      assert.equal(r.json.error.status, "UNAUTHENTICATED");
      assert.equal(reasonOf(r.json), "UNAUTHENTICATED");
    }
    const j = await rpc(c, "research", "SendMessage", { message: msg("echo hi") });
    assert.equal(j.status, 401);
    assert.equal(j.json.jsonrpc, "2.0");
    assert.equal(j.json.error.code, -31401);
    assert.equal(rpcReasonOf(j.json), "UNAUTHENTICATED");
    // A token is good once (P4-01 review): the same one again → 401.
    const once = await b.token(a.urn);
    assert.equal((await req(once, "GET", "/a2a")).status, 200);
    const again = await req(once, "GET", "/a2a");
    assert.equal(again.status, 401, again.text);
    // `aud` must be this Daisy alone (P4-01 review): a list with another → 401.
    const wide = (
      await b.self.sign({ sub: b.self.urn, aud: [a.urn, "urn:example:other"] as any, clientId: "a2a", scope: "daisy:invoke", ttlS: 300 })
    ).token;
    assert.equal((await req(wide, "GET", "/a2a")).status, 401);
    // No daisy:invoke → 403 insufficient_scope.
    const noScope = (await b.self.sign({ sub: b.self.urn, aud: a.urn, clientId: "a2a", scope: "daisy:session:read", ttlS: 300 })).token;
    const ns = await req(noScope, "GET", "/a2a/research/.well-known/agent-card.json");
    assert.equal(ns.status, 403);
    assert.equal(ns.json.error.details[0].metadata.code, "insufficient_scope");
    assert.match(String(ns.headers.get("www-authenticate")), /daisy:invoke/);
    // The owner (command line, web page) and the owner's AI: not callers here.
    // P5-02: through the relay (the outside face) these local credentials are
    // not even recognised — 401, one step earlier than 403 (ADR-101).
    const t = await runningTurn(a);
    for (const tok of [a.cli, a.ctx.issueToken(), t.ai]) {
      const r = await req(tok, "POST", "/a2a/research/message:send", { message: msg("echo hi") });
      assert.equal(r.status, VIA_RELAY ? 401 : 403, r.text);
      if (!VIA_RELAY) assert.equal(r.json.error.details[0].metadata.code, "visitors_only");
      const rr = await rpc(tok, "research", "GetTask", { id: "x" });
      assert.equal(rr.json.error.code, VIA_RELAY ? -31401 : -31403);
    }
    // And a visitor reaches nothing else (A2A only).
    const local = await req(b, "GET", "/api/sessions");
    assert.equal(local.status, 403);
    assert.equal(local.json.code, "a2a_only");
    // Nothing happened: no task, no card.
    assert.equal(count(a, "a2a_tasks"), 0);
    assert.equal(cardsRaised(a), before);
    void send;
  } finally {
    await s.close();
  }
});

test("T-3 at the A2A entry: a private agent, one not open to the caller, one that does not exist — 404 everywhere, no card, no task", async () => {
  const s = await setup();
  try {
    const { a, b, req, rpc, msg } = s;
    const before = cardsRaised(a);
    for (const aid of ["secret", "code", "nope"]) {
      for (const [m, path, body] of [
        ["GET", `/a2a/${aid}/.well-known/agent-card.json`],
        ["POST", `/a2a/${aid}/message:send`, { message: msg("echo hi") }],
        ["GET", `/a2a/${aid}/tasks`],
        ["GET", `/a2a/${aid}/tasks/x`],
        ["POST", `/a2a/${aid}/tasks/x:cancel`],
        ["POST", `/a2a/${aid}/message:stream`, { message: msg("echo hi") }],
        ["GET", `/a2a/${aid}/extendedAgentCard`],
      ] as const) {
        const r = await req(b, m, path, body);
        assert.equal(r.status, 404, `${aid} ${m} ${path}: ${r.text}`);
        assert.equal(r.json.error.status, "NOT_FOUND");
      }
      const j = await rpc(b, aid, "SendMessage", { message: msg("echo hi") });
      assert.equal(j.status, 404, j.text);
    }
    // The directory lists only what B may see.
    const dir = await req(b, "GET", "/a2a");
    assert.deepEqual(dir.json.agents.map((x: any) => x.agentId), ["research"]);
    assert.equal(dir.json.agents[0].card, `${s.root}/a2a/research/.well-known/agent-card.json`);
    // D (listed for 代码助手) sees both.
    const dd = await req(s.d, "GET", "/a2a");
    assert.deepEqual(dd.json.agents.map((x: any) => x.agentId).sort(), ["code", "research"]);
    // No card at the site root (no default agent).
    assert.equal((await req(b, "GET", "/.well-known/agent-card.json")).status, 404);
    assert.equal(count(a, "a2a_tasks"), 0);
    assert.equal(count(a, "a2a_contexts"), 0);
    assert.equal(cardsRaised(a), before);
  } finally {
    await s.close();
  }
});

test("the card: both transports (JSON-RPC first), Bearer, optional extensions only, streaming and push declared unsupported", async () => {
  const s = await setup();
  try {
    const r = await s.req(s.b, "GET", "/a2a/research/.well-known/agent-card.json", undefined, {});
    assert.equal(r.status, 200, r.text);
    const card = r.json;
    assert.equal(card.name, "研究助手");
    assert.deepEqual(card.supportedInterfaces, [
      { url: `${s.root}/a2a/research/jsonrpc`, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
      { url: `${s.root}/a2a/research`, protocolBinding: "HTTP+JSON", protocolVersion: "1.0" },
    ]);
    assert.equal(card.capabilities.streaming, false);
    assert.equal(card.capabilities.pushNotifications, false);
    assert.equal(card.capabilities.extendedAgentCard, false);
    assert.deepEqual(card.capabilities.extensions.map((e: any) => [e.uri, e.required]), [
      [A2A_EXT.act, false],
      [A2A_EXT.trace, false],
    ]);
    assert.ok(!/plugin/i.test(JSON.stringify(card)), "the card names none of this node's plugins");
    assert.equal(card.securitySchemes.bearer.httpAuthSecurityScheme.scheme, "Bearer");
    assert.deepEqual(card.securityRequirements, [{ schemes: { bearer: { list: [] } } }]);
    assert.match(String(r.headers.get("content-type")), /application\/a2a\+json/);
  } finally {
    await s.close();
  }
});

test("A2A-Version: missing or not 1.0 → VersionNotSupported (HTTP 400 / -32009); 1.0.x is fine", async () => {
  const s = await setup();
  try {
    const { b, send, rpc, msg } = s;
    for (const h of [{}, { "a2a-version": "0.3" }, { "a2a-version": "2.0" }] as Record<string, string>[]) {
      const r = await send(b, "research", msg("echo hi"), {}, h);
      assert.equal(r.status, 400, r.text);
      assert.equal(reasonOf(r.json), "VERSION_NOT_SUPPORTED");
      assert.match(r.json.error.message, /A2A-Version: 1\.0/);
      const j = await rpc(b, "research", "GetTask", { id: "x" }, h);
      assert.equal(j.json.error.code, -32009);
    }
    const ok = await send(b, "research", msg("echo hi"), {}, { "a2a-version": "1.0.1" });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(count(s.a, "a2a_tasks"), 1);
  } finally {
    await s.close();
  }
});

// ── the three ids (A-14, A-15, A-16, A-6) ────────────────────────────────

test("A-14: someone else's contextId, a reclaimed one, a made-up one → CONTEXT_NOT_FOUND, and no new conversation in its place (both transports)", async () => {
  const s = await setup();
  try {
    const { a, b, d, send, rpc, msg, req } = s;
    const first = await send(b, "research", msg("echo one"));
    assert.equal(first.status, 200, first.text);
    const ctx = first.json.task.contextId as string;
    const tid = first.json.task.id as string;
    assert.ok(ctx && tid && ctx !== tid);
    const contexts = count(a, "a2a_contexts");
    // D (a contact, may call research too) with B's contextId.
    const r = await send(d, "research", msg("echo mine now", { contextId: ctx }));
    assert.equal(r.status, 400, r.text);
    assert.equal(reasonOf(r.json), "CONTEXT_NOT_FOUND");
    const j = await rpc(d, "research", "SendMessage", { message: msg("echo mine", { contextId: ctx }) });
    assert.equal(j.json.error.code, -32602);
    assert.equal(rpcReasonOf(j.json), "CONTEXT_NOT_FOUND");
    // … nor B's task, by id (TaskNotFound, not "not yours").
    assert.equal(reasonOf((await req(d, "GET", `/a2a/research/tasks/${tid}`)).json), "TASK_NOT_FOUND");
    // A made-up one.
    assert.equal(reasonOf((await send(b, "research", msg("echo x", { contextId: "made-up-context" }))).json), "CONTEXT_NOT_FOUND");
    assert.equal(count(a, "a2a_contexts"), contexts);
    // Reclaimed: idle past seven days.
    a.ctx.store.run("UPDATE a2a_contexts SET active_at=0 WHERE id=?", ctx);
    assert.equal(a.ctx.a2a.sweep(true), 1);
    const late = await send(b, "research", msg("echo again", { contextId: ctx }));
    assert.equal(reasonOf(late.json), "CONTEXT_NOT_FOUND");
    assert.equal(reasonOf((await req(b, "GET", `/a2a/research/tasks/${tid}`)).json), "TASK_NOT_FOUND");
    assert.equal(count(a, "a2a_contexts"), contexts - 1);
    assert.equal(count(a, "a2a_messages"), 0);
    assert.equal(count(a, "a2a_message_ids"), 0);
  } finally {
    await s.close();
  }
});

test("A-14: a conversation with a task still open (waiting on the caller) is not reclaimed", async () => {
  const s = await setup();
  try {
    const { a, b, send, msg } = s;
    const r = await send(b, "research", msg("ask something"));
    assert.equal(r.json.task.status.state, "TASK_STATE_INPUT_REQUIRED");
    a.ctx.store.run("UPDATE a2a_contexts SET active_at=0");
    assert.equal(a.ctx.a2a.sweep(true), 0);
  } finally {
    await s.close();
  }
});

test("A-15: taskId and contextId that do not match → CONTEXT_MISMATCH; a taskId Daisy never issued → TaskNotFound (both transports)", async () => {
  const s = await setup();
  try {
    const { b, send, rpc, msg } = s;
    const one = (await send(b, "research", msg("ask one"))).json.task;
    const two = (await send(b, "research", msg("echo two"))).json.task;
    assert.notEqual(one.contextId, two.contextId);
    const r = await send(b, "research", msg("blue", { taskId: one.id, contextId: two.contextId }));
    assert.equal(r.status, 400, r.text);
    assert.equal(reasonOf(r.json), "CONTEXT_MISMATCH");
    const j = await rpc(b, "research", "SendMessage", { message: msg("blue", { taskId: one.id, contextId: "whatever" }) });
    assert.equal(j.json.error.code, -32602);
    assert.equal(rpcReasonOf(j.json), "CONTEXT_MISMATCH");
    // A new task with the caller's own id.
    const own = await send(b, "research", msg("echo mine", { taskId: "caller-made-task-id" }));
    assert.equal(own.status, 404, own.text);
    assert.equal(reasonOf(own.json), "TASK_NOT_FOUND");
    const jj = await rpc(b, "research", "SendMessage", { message: msg("echo mine", { taskId: "caller-made-task-id" }) });
    assert.equal(jj.json.error.code, -32001);
    // A reference to a task that is not there.
    const ref = await send(b, "research", msg("echo ref", { referenceTaskIds: ["nope-nope"] }));
    assert.equal(reasonOf(ref.json), "TASK_NOT_FOUND");
    // Only taskId: its conversation is derived (and the task goes on).
    const ok = await send(b, "research", msg("blue", { taskId: one.id }));
    assert.equal(ok.json.task.contextId, one.contextId);
    assert.equal(ok.json.task.status.state, "TASK_STATE_COMPLETED");
  } finally {
    await s.close();
  }
});

test("A-16: the same messageId with the same content returns the original task (run once); with other content → MESSAGE_ID_CONFLICT (both transports)", async () => {
  const s = await setup();
  try {
    const { b, send, rpc, msg, fx } = s;
    const m = msg("echo once");
    const r1 = await send(b, "research", m);
    const r2 = await send(b, "research", m, { returnImmediately: true });
    const r3 = await rpc(b, "research", "SendMessage", { message: m });
    assert.equal(r1.json.task.id, r2.json.task.id);
    assert.equal(r1.json.task.id, r3.json.result.task.id);
    assert.equal(r3.json.result.task.status.state, "TASK_STATE_COMPLETED");
    assert.equal(fx.runs.filter((j) => j.text === "echo once").length, 1);
    // Same id, other content.
    const c1 = await send(b, "research", { ...m, parts: [{ text: "echo twice" }] });
    assert.equal(c1.status, 400, c1.text);
    assert.equal(reasonOf(c1.json), "MESSAGE_ID_CONFLICT");
    assert.match(c1.json.error.message, /冲突/);
    const c2 = await rpc(b, "research", "SendMessage", { message: { ...m, metadata: { x: 1 } } });
    assert.equal(c2.json.error.code, -32602);
    assert.equal(rpcReasonOf(c2.json), "MESSAGE_ID_CONFLICT");
    // The same id from someone else is theirs (per caller).
    const dd = await send(s.d, "research", m);
    assert.equal(dd.status, 200);
    assert.notEqual(dd.json.task.id, r1.json.task.id);
    // A resend while the task is still running gets that task when it ends.
    const slow = msg("slow one");
    const first = await send(b, "research", slow, { returnImmediately: true });
    assert.equal(first.json.task.status.state, "TASK_STATE_WORKING");
    const held = send(b, "research", slow);
    await fx.release(first.json.task.id);
    const second = await held;
    assert.equal(second.json.task.id, first.json.task.id);
    assert.equal(second.json.task.status.state, "TASK_STATE_COMPLETED");
    assert.equal(fx.runs.filter((j) => j.text === "slow one").length, 1);
  } finally {
    await s.close();
  }
});

test("A-6: a message to an ended task is refused (UnsupportedOperation); a new messageId in the same contextId gets a new task with the history", async () => {
  const s = await setup();
  try {
    const { b, send, rpc, msg, fx, req } = s;
    const t1 = (await send(b, "research", msg("echo first answer"))).json.task;
    assert.equal(t1.status.state, "TASK_STATE_COMPLETED");
    assert.deepEqual(t1.artifacts, [{ artifactId: "answer", name: "回答", parts: [{ text: "first answer" }] }]);
    // To the ended task.
    const r = await send(b, "research", msg("echo more", { taskId: t1.id, contextId: t1.contextId }));
    assert.equal(r.status, 400, r.text);
    assert.equal(reasonOf(r.json), "UNSUPPORTED_OPERATION");
    assert.match(r.json.error.message, /不带 taskId/);
    const j = await rpc(b, "research", "SendMessage", { message: msg("echo more", { taskId: t1.id }) });
    assert.equal(j.json.error.code, -32004);
    // A new message in the same conversation → a new task, same contextId, the history handed over.
    const t2 = (await send(b, "research", msg("history please", { contextId: t1.contextId, referenceTaskIds: [t1.id] }))).json.task;
    assert.notEqual(t2.id, t1.id);
    assert.equal(t2.contextId, t1.contextId);
    assert.equal(t2.status.state, "TASK_STATE_COMPLETED");
    assert.deepEqual(JSON.parse(t2.artifacts[0].parts[0].text), {
      history: [["echo first answer", "first answer"]],
      references: [["echo first answer", "first answer"]],
    });
    // History: the caller's message; final answer in artifacts, not history.
    const got = await req(b, "GET", `/a2a/research/tasks/${t2.id}?historyLength=5`);
    assert.equal(got.json.history.length, 1);
    assert.equal(got.json.history[0].role, "ROLE_USER");
    assert.equal(got.json.history[0].contextId, t1.contextId);
    const none = await req(b, "GET", `/a2a/research/tasks/${t2.id}?historyLength=0`);
    assert.equal(none.json.history, undefined);
    assert.equal(fx.runs.length, 2);
  } finally {
    await s.close();
  }
});

test("A-5: the agent asks the caller for more (INPUT_REQUIRED, the blocking send returns there); the caller answers with the same taskId and the task completes — HTTP+JSON and JSON-RPC", async () => {
  const s = await setup();
  try {
    const { b, send, rpc, msg, req } = s;
    // HTTP+JSON.
    const t = (await send(b, "research", msg("ask about color"))).json.task;
    assert.equal(t.status.state, "TASK_STATE_INPUT_REQUIRED");
    assert.equal(t.status.message.role, "ROLE_AGENT");
    assert.equal(t.status.message.parts[0].text, "什么颜色？");
    // Something else while it waits: refused? No — a new task is fine; but a message to it while it runs is not.
    const done = (await send(b, "research", msg("blue", { taskId: t.id, contextId: t.contextId }))).json.task;
    assert.equal(done.id, t.id);
    assert.equal(done.contextId, t.contextId);
    assert.equal(done.status.state, "TASK_STATE_COMPLETED");
    assert.equal(done.artifacts[0].parts[0].text, "颜色是 blue；之前问的是 ask about color");
    assert.deepEqual(done.history.map((m: any) => m.role), ["ROLE_USER", "ROLE_AGENT", "ROLE_USER"]);
    // JSON-RPC, the whole way.
    const r1 = await rpc(b, "research", "SendMessage", { message: msg("ask again") });
    assert.equal(r1.status, 200);
    const t2 = r1.json.result.task;
    assert.equal(t2.status.state, "TASK_STATE_INPUT_REQUIRED");
    const r2 = await rpc(b, "research", "SendMessage", { message: msg("red", { taskId: t2.id }) });
    assert.equal(r2.json.result.task.status.state, "TASK_STATE_COMPLETED");
    assert.match(r2.json.result.task.artifacts[0].parts[0].text, /red/);
    const g = await rpc(b, "research", "GetTask", { id: t2.id, historyLength: 1 });
    assert.equal(g.json.result.history.length, 1);
    assert.equal(g.json.result.status.state, "TASK_STATE_COMPLETED");
    void req;
  } finally {
    await s.close();
  }
});

// ── blocking, cancel, list (D-26) ─────────────────────────────────────────

test("without returnImmediately the send is held until the task ends — no cap; with it the task comes back at once; cancel; list", async () => {
  const s = await setup();
  try {
    const { b, send, rpc, msg, req, fx } = s;
    let answered = false;
    const held = send(b, "research", msg("slow blocking")).then((r) => ((answered = true), r));
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(answered, false, "the blocking send must not return while the task runs");
    await fx.release();
    const r = await held;
    assert.equal(r.json.task.status.state, "TASK_STATE_COMPLETED");
    // returnImmediately: WORKING now; GetTask later.
    const quick = (await send(b, "research", msg("slow quick"), { returnImmediately: true })).json.task;
    assert.equal(quick.status.state, "TASK_STATE_WORKING");
    // A message to a running task is refused (only input-required takes more).
    const busy = await send(b, "research", msg("more", { taskId: quick.id }));
    assert.equal(reasonOf(busy.json), "UNSUPPORTED_OPERATION");
    // Cancel (HTTP+JSON): the executor is told; the task is CANCELED.
    const c = await req(b, "POST", `/a2a/research/tasks/${quick.id}:cancel`);
    assert.equal(c.status, 200, c.text);
    assert.equal(c.json.status.state, "TASK_STATE_CANCELED");
    assert.ok(fx.aborted.includes(quick.id));
    // Again: not cancelable (both transports).
    const again = await req(b, "POST", `/a2a/research/tasks/${quick.id}:cancel`);
    assert.equal(reasonOf(again.json), "TASK_NOT_CANCELABLE");
    assert.equal((await rpc(b, "research", "CancelTask", { id: quick.id })).json.error.code, -32002);
    // Someone else cannot cancel or see it.
    assert.equal(reasonOf((await req(s.d, "POST", `/a2a/research/tasks/${quick.id}:cancel`)).json), "TASK_NOT_FOUND");
    assert.equal((await rpc(s.d, "research", "CancelTask", { id: quick.id })).json.error.code, -32001);
    // A held send whose task is canceled gets the canceled task.
    const h2 = send(b, "research", msg("slow held"));
    await new Promise((r) => setTimeout(r, 100));
    const listed = await req(b, "GET", `/a2a/research/tasks?status=TASK_STATE_WORKING`);
    assert.equal(listed.json.tasks.length, 1);
    const cid = listed.json.tasks[0].id;
    const jc = await rpc(b, "research", "CancelTask", { id: cid });
    assert.equal(jc.json.result.status.state, "TASK_STATE_CANCELED");
    assert.equal((await h2).json.task.status.state, "TASK_STATE_CANCELED");
    // ListTasks: only B's, newest first, paged.
    await send(s.d, "research", msg("echo d's"));
    const all = await req(b, "GET", `/a2a/research/tasks?pageSize=2`);
    assert.equal(all.json.totalSize, 3);
    assert.equal(all.json.tasks.length, 2);
    assert.ok(all.json.nextPageToken);
    assert.equal(all.json.tasks[0].artifacts, undefined);
    const next = await req(b, "GET", `/a2a/research/tasks?pageSize=2&pageToken=${all.json.nextPageToken}&includeArtifacts=true`);
    assert.equal(next.json.tasks.length, 1);
    assert.equal(next.json.nextPageToken, "");
    assert.equal(next.json.tasks[0].artifacts[0].parts[0].text, "慢的做完了");
    const ids = [...all.json.tasks, ...next.json.tasks].map((t: any) => t.id);
    assert.equal(new Set(ids).size, 3);
    const lr = await rpc(b, "research", "ListTasks", { pageSize: 10, status: "TASK_STATE_CANCELED" });
    assert.equal(lr.json.result.tasks.length, 2);
    assert.equal((await req(b, "GET", `/a2a/research/tasks?pageToken=garbage`)).status, 400);
  } finally {
    await s.close();
  }
});

// ── the call authorization end to end (P4-03 through A2A) ─────────────────

test("T-1 through A2A: D's first call waits for the owner (AUTH_REQUIRED, the blocking send returns there); 永久通过 runs it; a refusal is REJECTED; cancel while waiting leaves the card", async () => {
  const s = await setup();
  try {
    const { a, d, send, req, msg } = s;
    const t = (await send(d, "research", msg("echo after approval"))).json.task;
    assert.equal(t.status.state, "TASK_STATE_AUTH_REQUIRED");
    const cards = a.ctx.access.invoke.requests("pending");
    assert.equal(cards.length, 1);
    // The owner says 永久通过 (PIN).
    const dec = await a.ctx.app.inject({
      method: "POST",
      url: fillPath(api.invoke.requestDecide.path, { rid: cards[0]!.id }),
      headers: a.withPin(),
      payload: { decision: "always" },
    });
    assert.equal(dec.statusCode, 200, dec.body);
    let got: any;
    for (let i = 0; i < 100; i++) {
      got = (await req(d, "GET", `/a2a/research/tasks/${t.id}`)).json;
      if (got.status.state === "TASK_STATE_COMPLETED") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(got.status.state, "TASK_STATE_COMPLETED");
    assert.equal(got.artifacts[0].parts[0].text, "after approval");
    // Next call: straight through.
    assert.equal((await send(d, "research", msg("echo direct"))).json.task.status.state, "TASK_STATE_COMPLETED");
    // Revoke the grant; the next call waits again; the owner says 拒绝 → REJECTED OWNER_REJECTED.
    const g = a.ctx.access.invoke.grants({})[0]!;
    await a.ctx.app.inject({ method: "DELETE", url: fillPath(api.invoke.grantRevoke.path, { gid: g.id }), headers: a.withPin() });
    const t2 = (await send(d, "research", msg("echo again"))).json.task;
    assert.equal(t2.status.state, "TASK_STATE_AUTH_REQUIRED");
    const rid = a.ctx.access.invoke.requests("pending")[0]!.id;
    await a.ctx.app.inject({
      method: "POST",
      url: fillPath(api.invoke.requestDecide.path, { rid }),
      headers: a.withPin(),
      payload: { decision: "reject" },
    });
    for (let i = 0; i < 100 && got.status.state !== "TASK_STATE_REJECTED"; i++) {
      got = (await req(d, "GET", `/a2a/research/tasks/${t2.id}`)).json;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(got.status.state, "TASK_STATE_REJECTED");
    assert.deepEqual(got.status.message.parts[1], { data: { reason: "OWNER_REJECTED" } });
    // Within the cooldown: rejected at once, no new card.
    const t3 = (await send(d, "research", msg("echo cooled"))).json.task;
    assert.equal(t3.status.state, "TASK_STATE_REJECTED");
    assert.equal(a.ctx.access.invoke.requests("pending").length, 0);
    // Cancel while waiting for the owner (review L-4, a2a-usage.md §5): CANCELED, and the
    // call leaves the card — a card nobody waits on any more is closed.
    a.ctx.store.run("UPDATE invoke_requests SET decided_at=0 WHERE decision='reject'");
    const t4 = (await send(d, "research", msg("echo wait"), { returnImmediately: true })).json.task;
    const t5 = (await send(d, "research", msg("echo wait too"), { returnImmediately: true })).json.task;
    assert.equal(t4.status.state, "TASK_STATE_AUTH_REQUIRED");
    const card4 = a.ctx.access.invoke.requests("pending")[0]!;
    const c = await req(d, "POST", `/a2a/research/tasks/${t4.id}:cancel`);
    assert.equal(c.json.status.state, "TASK_STATE_CANCELED");
    assert.equal(a.ctx.access.invoke.request(card4.id).status, "pending", "another call still waits on it");
    await req(d, "POST", `/a2a/research/tasks/${t5.id}:cancel`);
    assert.equal(a.ctx.access.invoke.request(card4.id).status, "canceled");
    assert.equal(a.ctx.access.invoke.requests("pending").length, 0);
  } finally {
    await s.close();
  }
});

test("T-5 through A2A: revoking the grant while a call runs stops it — REJECTED GRANT_REVOKED with the reason, the executor told; the blocking send answers", async () => {
  const s = await setup();
  try {
    const { a, d, send, msg, fx } = s;
    a.ctx.store.run(
      "INSERT INTO invoke_grants(id,agent_id,person,contact_id,subject,name,granted_at) VALUES('g-d','research',?,?,?,?,0)",
      d.card.id,
      d.card.id,
      d.self.urn,
      "D",
    );
    const held = send(d, "research", msg("slow and revoked"));
    for (let i = 0; i < 100 && !fx.gates.size; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(a.ctx.access.invoke.calls.list({ agentId: "research" }).length, 1);
    const rv = await a.ctx.app.inject({ method: "DELETE", url: fillPath(api.invoke.grantRevoke.path, { gid: "g-d" }), headers: a.withPin() });
    assert.equal(rv.statusCode, 200, rv.body);
    const r = await held;
    assert.equal(r.json.task.status.state, "TASK_STATE_REJECTED");
    assert.deepEqual(r.json.task.status.message.parts[1], { data: { reason: "GRANT_REVOKED" } });
    assert.match(r.json.task.status.message.parts[0].text, /停止/);
    assert.equal(fx.aborted.length, 1);
    assert.equal(a.ctx.access.invoke.calls.size, 0);
  } finally {
    await s.close();
  }
});

// ── restart (原则 2: never replayed) ──────────────────────────────────────

test("restart: tasks queued, running or waiting for the owner are failed INTERRUPTED (held sends get it); a task waiting on the caller goes on after the restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-a2a-restart-"));
  try {
    const s = await setup({ dir });
    const { b, d, send, msg } = s;
    const running = send(b, "research", msg("slow at restart"));
    const waiting = (await send(d, "research", msg("echo needs owner"))).json.task;
    assert.equal(waiting.status.state, "TASK_STATE_AUTH_REQUIRED");
    const asking = (await send(b, "research", msg("ask over a restart"))).json.task;
    assert.equal(asking.status.state, "TASK_STATE_INPUT_REQUIRED");
    for (let i = 0; i < 100 && !s.fx.gates.size; i++) await new Promise((r) => setTimeout(r, 10));
    await s.a.ctx.app.close();
    await s.a.iss.close();
    const r = await running;
    assert.equal(r.json.task.status.state, "TASK_STATE_FAILED");
    assert.deepEqual(r.json.task.status.message.parts[1], { data: { reason: "INTERRUPTED" } });
    // A crash leaves rows behind: the next start fails them (the wait lived in memory).
    const db = new DatabaseSync(join(dir, "daisy.sqlite"));
    db.prepare("UPDATE a2a_tasks SET state='TASK_STATE_AUTH_REQUIRED',status_message=NULL WHERE id=?").run(waiting.id);
    db.close();
    const a2 = await daisy({ dir });
    const fx2 = fixtureExecutor();
    register(a2, fx2);
    try {
      const row = a2.ctx.store.one("SELECT state,status_message FROM a2a_tasks WHERE id=?", waiting.id);
      assert.equal(row.state, "TASK_STATE_FAILED");
      assert.match(row.status_message, /INTERRUPTED/);
      const still = a2.ctx.store.one("SELECT state FROM a2a_tasks WHERE id=?", asking.id);
      assert.equal(still.state, "TASK_STATE_INPUT_REQUIRED");
      // The caller answers after the restart: the call authorization is asked again (B whitelisted) and it completes.
      await a2.ctx.app.listen({ host: "127.0.0.1", port: 0 });
      const c2 = client(a2, `http://127.0.0.1:${(a2.ctx.app.server.address() as any).port}`);
      const done = await c2.send(b, "research", c2.msg("green", { taskId: asking.id }));
      assert.equal(done.json.task.status.state, "TASK_STATE_COMPLETED", done.text);
      assert.match(done.json.task.artifacts[0].parts[0].text, /green/);
      // A new send while closing → nothing new is taken.
    } finally {
      await a2.ctx.app.close();
      await a2.iss.close();
      for (const p of [b, s.c, d]) p.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── unsupported operations, bad requests ──────────────────────────────────

test("unsupported: streaming, subscribe, push notifications, the extended card — the spec's errors in both transports; bad requests are A2A errors", async () => {
  const s = await setup();
  try {
    const { b, req, rpc, send, msg } = s;
    const cases: [string, string, unknown, string][] = [
      ["POST", "/a2a/research/message:stream", { message: msg("echo") }, "UNSUPPORTED_OPERATION"],
      ["POST", "/a2a/research/tasks/abc:subscribe", undefined, "UNSUPPORTED_OPERATION"],
      ["GET", "/a2a/research/tasks/abc/pushNotificationConfigs", undefined, "PUSH_NOTIFICATION_NOT_SUPPORTED"],
      ["POST", "/a2a/research/tasks/abc/pushNotificationConfigs", {}, "PUSH_NOTIFICATION_NOT_SUPPORTED"],
      ["GET", "/a2a/research/tasks/abc/pushNotificationConfigs/c1", undefined, "PUSH_NOTIFICATION_NOT_SUPPORTED"],
      ["DELETE", "/a2a/research/tasks/abc/pushNotificationConfigs/c1", undefined, "PUSH_NOTIFICATION_NOT_SUPPORTED"],
      ["GET", "/a2a/research/extendedAgentCard", undefined, "EXTENDED_AGENT_CARD_NOT_CONFIGURED"],
    ];
    for (const [m, path, body, reason] of cases) {
      const r = await req(b, m, path, body);
      assert.equal(r.status, 400, `${m} ${path}: ${r.text}`);
      assert.equal(reasonOf(r.json), reason, path);
    }
    const rpcCases: [string, number][] = [
      ["SendStreamingMessage", -32004],
      ["SubscribeToTask", -32004],
      ["CreateTaskPushNotificationConfig", -32003],
      ["GetTaskPushNotificationConfig", -32003],
      ["ListTaskPushNotificationConfigs", -32003],
      ["DeleteTaskPushNotificationConfig", -32003],
      ["GetExtendedAgentCard", -32007],
      ["message/send", -32601],
      ["Nope", -32601],
    ];
    for (const [method, code] of rpcCases) {
      const r = await rpc(b, "research", method, { message: msg("echo") });
      assert.equal(r.json.error.code, code, method);
    }
    // Push config inside a send; output modes without text; a url part; too many parts; a bad messageId.
    const push = await send(b, "research", msg("echo"), { taskPushNotificationConfig: { url: "https://x.example" } });
    assert.equal(reasonOf(push.json), "PUSH_NOTIFICATION_NOT_SUPPORTED");
    const modes = await send(b, "research", msg("echo"), { acceptedOutputModes: ["image/png"] });
    assert.equal(reasonOf(modes.json), "CONTENT_TYPE_NOT_SUPPORTED");
    assert.equal((await rpc(b, "research", "SendMessage", { message: msg("echo"), configuration: { acceptedOutputModes: ["image/png"] } })).json.error.code, -32005);
    const url = await send(b, "research", { ...msg("x"), parts: [{ url: "https://example.com/f" }] });
    assert.equal(reasonOf(url.json), "INVALID_ARGUMENT");
    assert.ok(url.json.error.details.some((d: any) => d.fieldViolations?.some((f: any) => /url/.test(f.field))));
    const many = await send(b, "research", { ...msg("x"), parts: Array.from({ length: 17 }, () => ({ text: "p" })) });
    assert.equal(reasonOf(many.json), "INVALID_ARGUMENT");
    const short = await send(b, "research", { ...msg("x"), messageId: "short" });
    assert.equal(reasonOf(short.json), "INVALID_ARGUMENT");
    // JSON-RPC envelope problems.
    const parse = await req(b, "POST", "/a2a/research/jsonrpc", "{not json");
    assert.equal(parse.json.error.code, -32700);
    const batch = await req(b, "POST", "/a2a/research/jsonrpc", [{ jsonrpc: "2.0", id: 1, method: "GetTask" }]);
    assert.equal(batch.json.error.code, -32600);
    const noVer = await req(b, "POST", "/a2a/research/jsonrpc", { jsonrpc: "1.0", id: 1, method: "GetTask" });
    assert.equal(noVer.json.error.code, -32600);
    const bad = await rpc(b, "research", "SendMessage", { message: { messageId: "x" } });
    assert.equal(bad.json.error.code, -32602);
    assert.equal(bad.json.id, bad.json.id);
    // Nothing above made a task.
    assert.equal(count(s.a, "a2a_tasks"), 0);
  } finally {
    await s.close();
  }
});

test("act only with the header and the metadata; files in and out; an executor error is FAILED without its details; trace depth over 8 is REJECTED", async () => {
  const s = await setup();
  try {
    const { b, send, msg } = s;
    const actMeta = { [A2A_EXT.act]: { mode: "act" } };
    const noHeader = await send(b, "research", msg("mode", { metadata: actMeta }));
    assert.equal(noHeader.json.task.artifacts[0].parts[0].text, "ask");
    const withHeader = await send(b, "research", msg("mode", { metadata: actMeta, extensions: [A2A_EXT.act] }), {}, { ...V, "a2a-extensions": A2A_EXT.act });
    assert.equal(withHeader.json.task.artifacts[0].parts[0].text, "act");
    const headerOnly = await send(b, "research", msg("mode"), {}, { ...V, "a2a-extensions": A2A_EXT.act });
    assert.equal(headerOnly.json.task.artifacts[0].parts[0].text, "ask");
    // Files: a raw part in, an artifact out.
    const f = await send(b, "research", { ...msg("files"), parts: [{ text: "files" }, { raw: Buffer.from("abc").toString("base64"), filename: "a.txt", mediaType: "text/plain" }] });
    assert.equal(f.json.task.artifacts[0].parts[0].text, "收到 1 个文件");
    assert.deepEqual(f.json.task.artifacts[1], { artifactId: "file-1", name: "out.txt", parts: [{ raw: Buffer.from("hello").toString("base64"), filename: "out.txt", mediaType: "text/plain" }] });
    // An executor error: FAILED, EXECUTION_ERROR, nothing of its message.
    const boom = await send(b, "research", msg("boom"));
    assert.equal(boom.json.task.status.state, "TASK_STATE_FAILED");
    assert.deepEqual(boom.json.task.status.message.parts[1], { data: { reason: "EXECUTION_ERROR" } });
    assert.ok(!JSON.stringify(boom.json).includes("secret details"));
    // trace.md: depth 9 → REJECTED, never run.
    const deep = await send(b, "research", msg("echo deep", { metadata: { [A2A_EXT.trace]: { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-00", depth: 9 } } }));
    assert.equal(deep.json.task.status.state, "TASK_STATE_REJECTED");
    assert.deepEqual(deep.json.task.status.message.parts[1], { data: { reason: "TRACE_DEPTH_EXCEEDED" } });
    assert.ok(!s.fx.runs.some((j) => j.text === "echo deep"));
    const ok = await send(b, "research", msg("echo depth8", { metadata: { [A2A_EXT.trace]: { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-00", depth: 8 } } }));
    assert.equal(ok.json.task.status.state, "TASK_STATE_COMPLETED");
    assert.deepEqual(s.fx.runs.at(-1)!.trace, { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", depth: 8 });
  } finally {
    await s.close();
  }
});

test("no executor for an agent (P4-05 / P4-07 not there): an admitted call is REJECTED AGENT_UNAVAILABLE", async () => {
  const a = await daisy();
  const b = await peerDaisy("B");
  try {
    a.ctx.access.invoke.agents.add((id) => AGENTS[id] ?? null);
    await a.ctx.app.inject({ method: "POST", url: api.contacts.contactImport.path, headers: a.withPin(), payload: { card: b.text, whitelist: true } });
    await a.ctx.app.listen({ host: "127.0.0.1", port: 0 });
    const c = client(a, `http://127.0.0.1:${(a.ctx.app.server.address() as any).port}`);
    const r = await c.send(b, "research", c.msg("echo hi"));
    assert.equal(r.json.task.status.state, "TASK_STATE_REJECTED");
    assert.deepEqual(r.json.task.status.message.parts[1], { data: { reason: "AGENT_UNAVAILABLE" } });
    assert.equal(a.ctx.access.invoke.calls.size, 0);
  } finally {
    await a.close();
    b.close();
  }
});

test("the A2A routes are the visitors' only door: in the table with visitors: true, daisy:invoke, no owner channel", () => {
  const routes = Object.values(api.a2a) as AnyRoute[];
  assert.equal(routes.length, 13);
  for (const r of routes) {
    assert.equal(r.visitors, true, r.id);
    assert.equal(r.scope, "daisy:invoke", r.id);
    assert.deepEqual(r.channels, [], r.id);
    assert.equal(r.pin, false, r.id);
    assert.match(r.path, /^\/a2a(\/|$)/, r.id);
  }
});

// ── a client we did not write ─────────────────────────────────────────────

test("interop: the official A2A JS SDK (@a2a-js/sdk 1.3.0) reads the card and talks to both transports — send, get, list, cancel", async () => {
  const s = await setup();
  try {
    const sdk = await import("@a2a-js/sdk/client");
    const TS: any = await import("@a2a-js/sdk");
    const { b, a, fx } = s;
    // The SDK takes a fetch; ours signs a fresh cross-Daisy token per request (as P4-08 will).
    const fetchImpl = async (input: any, init: any = {}) => {
      const headers = new Headers(init.headers ?? {});
      headers.set("authorization", `Bearer ${await b.token(a.urn)}`);
      if (VIA_RELAY) return viaRelayFetch(String(input), { ...init, headers: Object.fromEntries(headers.entries()) });
      return fetch(input, { ...init, headers });
    };
    for (const binding of ["JSONRPC", "HTTP+JSON"]) {
      const factory = new sdk.ClientFactory({
        transports: [new sdk.JsonRpcTransportFactory({ fetchImpl }), new sdk.RestTransportFactory({ fetchImpl })],
        preferredTransports: [binding],
        cardResolver: new sdk.DefaultAgentCardResolver({ fetchImpl }),
      } as any);
      // The SDK resolves the card path relative to the base: give it with a trailing slash.
      const client = await factory.createFromUrl(`${s.root}/a2a/research/`);
      const res: any = await client.sendMessage({
        message: { messageId: `sdk-${binding}-0001`, role: TS.Role.ROLE_USER, parts: [{ content: { $case: "text", value: "echo from the sdk" } }] },
      } as any);
      // A Task (not a Message), blocking by default (D-26): completed.
      assert.equal(res.status.state, TS.TaskState.TASK_STATE_COMPLETED, binding);
      assert.equal(res.artifacts[0].parts[0].content.value, "from the sdk", binding);
      const got: any = await client.getTask({ id: res.id } as any);
      assert.equal(got.id, res.id);
      assert.equal(got.contextId, res.contextId);
      assert.equal(got.status.state, TS.TaskState.TASK_STATE_COMPLETED);
      const listed: any = await client.listTasks({ pageSize: 5, status: TS.TaskState.TASK_STATE_UNSPECIFIED } as any);
      assert.ok(listed.tasks.some((t: any) => t.id === res.id), binding);
      // input-required, then the answer on the same task (A-5 through the SDK).
      const asked: any = await client.sendMessage({
        message: { messageId: `sdk-${binding}-0003`, role: TS.Role.ROLE_USER, parts: [{ content: { $case: "text", value: "ask via sdk" } }] },
      } as any);
      assert.equal(asked.status.state, TS.TaskState.TASK_STATE_INPUT_REQUIRED);
      const answered: any = await client.sendMessage({
        message: { messageId: `sdk-${binding}-0004`, taskId: asked.id, contextId: asked.contextId, role: TS.Role.ROLE_USER, parts: [{ content: { $case: "text", value: "teal" } }] },
      } as any);
      assert.equal(answered.id, asked.id);
      assert.equal(answered.status.state, TS.TaskState.TASK_STATE_COMPLETED);
      // A slow one, returned at once, then canceled.
      const quick: any = await client.sendMessage({
        message: { messageId: `sdk-${binding}-0002`, role: TS.Role.ROLE_USER, parts: [{ content: { $case: "text", value: "slow sdk" } }] },
        configuration: { returnImmediately: true, acceptedOutputModes: ["text/plain"] },
      } as any);
      assert.equal(quick.status.state, TS.TaskState.TASK_STATE_WORKING);
      const canceled: any = await client.cancelTask({ id: quick.id } as any);
      assert.equal(canceled.status.state, TS.TaskState.TASK_STATE_CANCELED, binding);
      // An error comes back as the SDK's error type.
      await assert.rejects(client.getTask({ id: "no-such-task" } as any), (e: any) => {
        assert.equal(e?.name, "TaskNotFoundError", binding);
        return true;
      });
    }
    assert.equal(fx.runs.filter((j) => j.text === "echo from the sdk").length, 2);
  } finally {
    await s.close();
  }
});

test("X-2 at the A2A entry: someone else's token from the external issuer (with daisy:invoke) is a caller too — sees the card, its first call waits for the owner", async () => {
  const s = await setup();
  try {
    const { a, req, send, msg } = s;
    assert.equal((await a.configure()).statusCode, 200);
    const other = () => a.tokenFor("user:someone-else", { scope: "daisy:invoke" });
    const card = await req(await other(), "GET", "/a2a/research/.well-known/agent-card.json");
    assert.equal(card.status, 200, card.text);
    // 代码助手 is for listed contacts only: not for them.
    assert.equal((await req(await other(), "GET", "/a2a/code/.well-known/agent-card.json")).status, 404);
    const r = await req(await other(), "POST", "/a2a/research/message:send", { message: msg("echo from issuer") });
    assert.equal(r.json.task.status.state, "TASK_STATE_AUTH_REQUIRED");
    const card0 = a.ctx.access.invoke.requests("pending")[0]!;
    assert.match(card0.caller.subject, /someone-else/);
    // Without daisy:invoke: 403.
    const noScope = await req(await a.tokenFor("user:someone-else"), "GET", "/a2a");
    assert.equal(noScope.status, 403);
    // The conversation is theirs: B cannot use it.
    const ctx = r.json.task.contextId;
    assert.equal(reasonOf((await send(s.b, "research", msg("echo x", { contextId: ctx }))).json), "CONTEXT_NOT_FOUND");
  } finally {
    await s.close();
  }
});

test("P4-03's final API through A2A: 仅本次 lets only the call that raised the card run (the other stays AUTH_REQUIRED on a fresh card); too many waiting → REJECTED QUOTA_EXCEEDED; begin refusing → REJECTED", async () => {
  const s = await setup();
  try {
    const { a, d, send, req, msg } = s;
    const inv = a.ctx.access.invoke;
    const first = (await send(d, "research", msg("echo first"))).json.task;
    const second = (await send(d, "research", msg("echo second"))).json.task;
    assert.equal(first.status.state, "TASK_STATE_AUTH_REQUIRED");
    assert.equal(second.status.state, "TASK_STATE_AUTH_REQUIRED");
    const rid = inv.requests("pending")[0]!.id;
    const dec = await a.ctx.app.inject({ method: "POST", url: fillPath(api.invoke.requestDecide.path, { rid }), headers: a.withPin(), payload: { decision: "once" } });
    assert.equal(dec.statusCode, 200, dec.body);
    const stateOf = async (id: string) => (await req(d, "GET", `/a2a/research/tasks/${id}`)).json.status.state;
    for (let i = 0; i < 100 && (await stateOf(first.id)) !== "TASK_STATE_COMPLETED"; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(await stateOf(first.id), "TASK_STATE_COMPLETED");
    assert.equal(await stateOf(second.id), "TASK_STATE_AUTH_REQUIRED");
    assert.equal(inv.requests("pending").length, 1, "the other call waits on a fresh card");
    // Too many calls waiting from one person: the A2A server's own cap (review M-1:
    // open tasks per caller × agent) answers first — 429, nothing stored.
    const statuses: number[] = [];
    for (let i = 0; i < 20; i++) statuses.push((await send(d, "research", msg(`echo many ${i}`), { returnImmediately: true })).status);
    assert.ok(statuses.includes(429), statuses.join());
    // begin refusing (the permission went away between the decision and the start): REJECTED, nothing runs.
    const orig = inv.begin.bind(inv);
    (inv as any).begin = () => {
      throw new InvokeError(403, "这次调用不能开始：测试", "not_admitted");
    };
    try {
      const t = (await send(s.b, "research", msg("echo never"))).json.task;
      assert.equal(t.status.state, "TASK_STATE_REJECTED");
      assert.deepEqual(t.status.message.parts[1], { data: { reason: "GRANT_REVOKED" } });
      assert.ok(!s.fx.runs.some((j) => j.text === "echo never"));
    } finally {
      (inv as any).begin = orig;
    }
  } finally {
    await s.close();
  }
});

// ── security review (P4-04) ───────────────────────────────────────────────

const rowsOf = (a: Daisy, taskId: string) => a.ctx.store.all("SELECT role,data FROM a2a_messages WHERE task_id=? ORDER BY seq", taskId);

test("review M-1: metadata is bounded; before a call has begun only a stub is stored (no file bytes, no metadata) — the whole message once it begins", async () => {
  const s = await setup();
  try {
    const { a, b, d, send, msg } = s;
    const big = { blob: "x".repeat(17 * 1024) };
    assert.equal(reasonOf((await send(b, "research", msg("echo m", { metadata: big }))).json), "INVALID_ARGUMENT");
    assert.equal(reasonOf((await send(b, "research", { ...msg("x"), parts: [{ text: "echo p", metadata: big }] })).json), "INVALID_ARGUMENT");
    assert.equal(count(a, "a2a_tasks"), 0);
    // D waits for the owner: a stub only.
    const file = Buffer.alloc(300_000, 7).toString("base64");
    const m = { ...msg("x"), parts: [{ text: "echo stubbed" }, { raw: file, filename: "f.bin", mediaType: "application/octet-stream" }], metadata: { note: "y".repeat(1000) } };
    const t = (await send(d, "research", m)).json.task;
    assert.equal(t.status.state, "TASK_STATE_AUTH_REQUIRED");
    const stub = rowsOf(a, t.id)[0].data as string;
    assert.ok(stub.length < 3000, `stub is ${stub.length} characters`);
    assert.ok(!stub.includes(file.slice(0, 100)) && !stub.includes("yyyy"));
    assert.match(stub, /f\.bin/);
    // The owner approves: the whole message is kept, and the executor gets the file.
    const rid = a.ctx.access.invoke.requests("pending")[0]!.id;
    await a.ctx.app.inject({ method: "POST", url: fillPath(api.invoke.requestDecide.path, { rid }), headers: a.withPin(), payload: { decision: "always" } });
    for (let i = 0; i < 100 && !s.fx.runs.some((j) => j.taskId === t.id); i++) await new Promise((r) => setTimeout(r, 10));
    const job = s.fx.runs.find((j) => j.taskId === t.id)!;
    assert.equal(job.files[0]!.bytes.length, 300_000);
    assert.ok((rowsOf(a, t.id)[0].data as string).includes(file.slice(0, 100)));
    // Refused at once (the cooldown): a stub only, for good.
    a.ctx.store.run("DELETE FROM invoke_grants");
    a.ctx.store.run(
      "INSERT INTO invoke_requests(id,agent_id,agent_name,person,contact_id,subject,name,status,created,expires_at,calls,decision,decided_at) VALUES('r-old','research','研究助手',?,?,?,'D','rejected',0,0,1,'reject',?)",
      d.card.id,
      d.card.id,
      d.self.urn,
      Date.now(),
    );
    const refused = (await send(d, "research", { ...m, messageId: "refused-0001" })).json.task;
    assert.equal(refused.status.state, "TASK_STATE_REJECTED");
    assert.ok((rowsOf(a, refused.id)[0].data as string).length < 3000);
  } finally {
    await s.close();
  }
});

test("review M-1: per-caller limits are checked before anything is stored — open tasks per agent, live conversations, stored bytes, sends per minute (429 + Retry-After)", async () => {
  const s = await setup();
  try {
    const { a, b, send, rpc, msg } = s;
    // Open tasks on one agent.
    let ctx0 = "";
    for (let i = 0; i < 16; i++) {
      const r = await send(b, "research", msg("loop"));
      assert.equal(r.json?.task?.status.state, "TASK_STATE_INPUT_REQUIRED", `${i}: ${r.text}`);
      ctx0 ||= r.json.task.contextId;
    }
    const tasks = count(a, "a2a_tasks");
    const over = await send(b, "research", msg("loop"));
    assert.equal(over.status, 429, over.text);
    assert.equal(reasonOf(over.json), "RESOURCE_EXHAUSTED");
    assert.ok(Number(over.headers.get("retry-after")) > 0);
    assert.equal((await rpc(b, "research", "SendMessage", { message: msg("loop") })).json.error.code, -31429);
    assert.equal(count(a, "a2a_tasks"), tasks);
    // Live conversations (all agents): 50.
    a.ctx.store.run("UPDATE a2a_tasks SET state='TASK_STATE_COMPLETED'");
    for (let i = count(a, "a2a_contexts"); i < 50; i++)
      a.ctx.store.run("INSERT INTO a2a_contexts(id,agent_id,caller,created,active_at) VALUES(?,?,?,?,?)", `c-${i}`, "research", `contact:${b.card.id}`, Date.now(), Date.now());
    assert.equal(reasonOf((await send(b, "research", msg("echo new conversation"))).json), "RESOURCE_EXHAUSTED");
    // …but one may still go on in an existing one.
    const old1 = await send(b, "research", msg("echo old one", { contextId: ctx0 }));
    assert.equal(old1.json?.task?.status.state, "TASK_STATE_COMPLETED", old1.text);
    // Stored bytes.
    a.ctx.store.run("INSERT INTO a2a_messages(task_id,context_id,role,message_id,data,created) VALUES('t-big',?,'ROLE_USER','m-big',?,0)", ctx0, "z".repeat(64 * 1024 * 1024));
    assert.equal(reasonOf((await send(b, "research", msg("echo more", { contextId: ctx0 }))).json), "RESOURCE_EXHAUSTED");
    a.ctx.store.run("DELETE FROM a2a_messages WHERE task_id='t-big'");
  } finally {
    await s.close();
  }
});

test("review M-1: at most 60 sends a minute per caller — the 61st is 429, someone else is unaffected", async () => {
  const s = await setup();
  try {
    const { b, d, send, msg } = s;
    const m = msg("echo again and again");
    let last: any;
    for (let i = 0; i < 61; i++) last = await send(b, "research", m, { returnImmediately: true });
    assert.equal(last.status, 429, last.text);
    assert.equal(reasonOf(last.json), "RESOURCE_EXHAUSTED");
    assert.equal((await send(d, "research", msg("echo d"), { returnImmediately: true })).status, 200);
  } finally {
    await s.close();
  }
});

test("review M-2: one held connection per caller × task (a newer resend takes over, the older is answered now); at most 8 held per caller (503 + Retry-After); the outside face bounds connections and keeps TCP alive", async () => {
  const s = await setup();
  try {
    const { a, b, send, msg, fx } = s;
    const m = msg("slow held");
    const first = send(b, "research", m);
    for (let i = 0; i < 100 && !fx.gates.size; i++) await new Promise((r) => setTimeout(r, 10));
    const second = send(b, "research", m);
    const r1 = await first; // answered as it stands once the second took over
    assert.equal(r1.json.task.status.state, "TASK_STATE_WORKING");
    await fx.release();
    assert.equal((await second).json.task.status.state, "TASK_STATE_COMPLETED");
    // Eight held at once; the ninth is refused before anything is stored.
    const held = Array.from({ length: 8 }, (_, i) => send(b, "research", msg(`slow ${i}`)));
    for (let i = 0; i < 200 && fx.gates.size < 8; i++) await new Promise((r) => setTimeout(r, 10));
    const tasks = count(a, "a2a_tasks");
    const ninth = await send(b, "research", msg("slow nine"));
    assert.equal(ninth.status, 503, ninth.text);
    assert.equal(reasonOf(ninth.json), "UNAVAILABLE");
    assert.ok(Number(ninth.headers.get("retry-after")) > 0);
    assert.equal(count(a, "a2a_tasks"), tasks);
    // returnImmediately is always fine.
    assert.equal((await send(b, "research", msg("echo quick"), { returnImmediately: true })).status, 200);
    for (const k of [...fx.gates.keys()]) await fx.release(k);
    await Promise.all(held);
    // The outside face.
    const net = await import("node:net");
    const calls: unknown[][] = [];
    const orig = net.Socket.prototype.setKeepAlive;
    net.Socket.prototype.setKeepAlive = function (this: any, ...args: any[]) {
      calls.push(args);
      return orig.apply(this, args as any);
    } as any;
    try {
      await a.ctx.access.faces.startExternal({ enabled: true, host: "127.0.0.1", port: 0, tls: false, allow: { terminal: false, shell: false, browse: false } });
      const srv = a.ctx.access.faces.externalServer!;
      assert.equal(srv.maxConnections, 1024);
      const port = (srv.address() as any).port;
      await new Promise<void>((ok) => {
        const c = net.connect(port, "127.0.0.1", () => setTimeout(() => (c.destroy(), ok()), 50));
      });
      assert.ok(calls.some((x) => x[0] === true && x[1] === 60_000), JSON.stringify(calls));
    } finally {
      net.Socket.prototype.setKeepAlive = orig;
      await a.ctx.access.faces.stopExternal();
    }
  } finally {
    await s.close();
  }
});

test("review L-1: the external issuer's token for the owner's own sub with act (an AI acting for the owner) is not an A2A caller", async () => {
  const s = await setup();
  try {
    const { a, req } = s;
    assert.equal((await a.configure()).statusCode, 200);
    const tok = await a.tokenFor("user:zz-owner", { act: { sub: "agent:x" }, scope: "daisy:invoke" });
    const r = await req(tok, "GET", "/a2a/research/.well-known/agent-card.json");
    assert.equal(r.status, 403, r.text);
    assert.equal(r.json.error.details[0].metadata.code, "insufficient_scope");
  } finally {
    await s.close();
  }
});

test("review L-2: a task waiting on the caller fails after 24 h idle and its call ends; at most 16 messages per task; a 仅本次 call asks again when the caller answers", async () => {
  const s = await setup();
  try {
    const { a, b, d, send, req, msg } = s;
    const t = (await send(b, "research", msg("loop"))).json.task;
    assert.equal(a.ctx.access.invoke.calls.size, 1);
    a.ctx.store.run("UPDATE a2a_tasks SET updated=? WHERE id=?", Date.now() - 25 * 3600_000, t.id);
    a.ctx.a2a.sweep(true);
    const g = (await req(b, "GET", `/a2a/research/tasks/${t.id}`)).json;
    assert.equal(g.status.state, "TASK_STATE_FAILED");
    assert.deepEqual(g.status.message.parts[1], { data: { reason: "INPUT_EXPIRED" } });
    assert.equal(a.ctx.access.invoke.calls.size, 0);
    // 16 messages per task: the first and 15 answers; the 17th message is refused.
    const u = (await send(b, "research", msg("loop"))).json.task;
    for (let i = 0; i < 15; i++) assert.equal((await send(b, "research", msg(`more ${i}`, { taskId: u.id }))).json.task.status.state, "TASK_STATE_INPUT_REQUIRED");
    const capped = await send(b, "research", msg("one too many", { taskId: u.id }));
    assert.equal(capped.status, 429, capped.text);
    // 仅本次: D's call runs once; its continuation goes back to the owner.
    const v = (await send(d, "research", msg("loop"))).json.task;
    const rid = a.ctx.access.invoke.requests("pending")[0]!.id;
    await a.ctx.app.inject({ method: "POST", url: fillPath(api.invoke.requestDecide.path, { rid }), headers: a.withPin(), payload: { decision: "once" } });
    let st = "";
    for (let i = 0; i < 100 && st !== "TASK_STATE_INPUT_REQUIRED"; i++) {
      st = (await req(d, "GET", `/a2a/research/tasks/${v.id}`)).json.status.state;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(st, "TASK_STATE_INPUT_REQUIRED");
    const again = (await send(d, "research", msg("and this", { taskId: v.id }))).json.task;
    assert.equal(again.status.state, "TASK_STATE_AUTH_REQUIRED");
    assert.equal(a.ctx.access.invoke.requests("pending").length, 1);
  } finally {
    await s.close();
  }
});

test("review L-3: a continuation arriving while the call is being stopped is refused (not run on a revoked call)", async () => {
  const s = await setup();
  try {
    const { a, d, send, msg } = s;
    a.ctx.store.run(
      "INSERT INTO invoke_grants(id,agent_id,person,contact_id,subject,name,granted_at) VALUES('g-d','research',?,?,?,?,0)",
      d.card.id,
      d.card.id,
      d.self.urn,
      "D",
    );
    const t = (await send(d, "research", msg("loop"))).json.task;
    assert.equal(t.status.state, "TASK_STATE_INPUT_REQUIRED");
    const p = (await a.ctx.access.guard.identify(await d.token(a.urn), "external"))!;
    const runs = s.fx.runs.length;
    // Revoke and answer in the same tick: the REJECTED is still on its way.
    a.ctx.access.invoke.revokeGrant("g-d", "test");
    await assert.rejects(
      a.ctx.a2a.send(p, "research", { message: { messageId: "cont-0001", role: "ROLE_USER", parts: [{ text: "now" }], taskId: t.id } } as any, { extensions: [] }),
      (e: any) => e.reason === "UNSUPPORTED_OPERATION",
    );
    await new Promise((r) => setImmediate(r));
    assert.equal(a.ctx.store.one("SELECT state FROM a2a_tasks WHERE id=?", t.id).state, "TASK_STATE_REJECTED");
    assert.equal(s.fx.runs.length, runs);
  } finally {
    await s.close();
  }
});

test("review L-5: a JSON text's depth is read from the text (strings and escapes do not count), the same as the parsed value's, and stops past the cap", () => {
  for (const v of [1, "x", [], {}, { a: [1, { b: "[{" }] }, [[[["\\\"]"]]]], { s: '{"\\\\": ["\\""]}', n: { m: [null, { o: {} }] } }])
    assert.equal(jsonTextDepth(JSON.stringify(v)), jsonDepth(v), JSON.stringify(v));
  assert.equal(jsonTextDepth("[".repeat(10_000_000), 48), 49);
});

test("review L-5 / L-6 / L-7: deep JSON → 400 not 500; an oversized body → A2A-shaped 413 in both transports, a 12 MB file fits; a failure preparing the task tells the caller nothing of it", async () => {
  const s = await setup();
  try {
    const { a, b, req, send, rpc, msg } = s;
    // The deep value is written as JSON text, never built or stringified as
    // an object here: JSON.stringify recurses, and Linux's smaller stack
    // overflows on it in the test itself (CI run 44103553516).
    const DEEP = '"__deep__"';
    const deepText = '{"d":'.repeat(100_000) + "1" + "}".repeat(100_000);
    const deepBody = (body: unknown) => JSON.stringify(body).replace(DEEP, () => deepText);
    const r = await req(b, "POST", "/a2a/research/message:send", deepBody({ message: msg("echo deep", { metadata: { deep: "__deep__" } }), configuration: {} }));
    assert.equal(r.status, 400, r.text.slice(0, 300));
    assert.equal(reasonOf(r.json), "INVALID_ARGUMENT");
    const rd = await req(b, "POST", "/a2a/research/message:send", deepBody({ message: { ...msg("x"), parts: [{ data: "__deep__" }] } }));
    assert.equal(rd.status, 400, rd.text.slice(0, 300));
    assert.equal(reasonOf(rd.json), "INVALID_ARGUMENT");
    const rj = await req(b, "POST", "/a2a/research/jsonrpc", deepBody({ jsonrpc: "2.0", id: 7, method: "SendMessage", params: { message: msg("echo deep", { metadata: { deep: "__deep__" } }) } }));
    assert.equal(rj.status, 200, rj.text.slice(0, 300));
    assert.equal(rj.json.error.code, -32602, rj.text.slice(0, 300));
    // Deep anywhere else in the body (a field the schema does not keep) is refused too.
    const rx = await req(b, "POST", "/a2a/research/message:send", deepBody({ message: msg("x"), configuration: { extra: "__deep__" } }));
    assert.equal(rx.status, 400, rx.text.slice(0, 300));
    assert.equal(reasonOf(rx.json), "INVALID_ARGUMENT");
    // Over the body limit.
    // (In process: over a socket the answer comes before the upload ends and the client only sees a broken pipe.)
    const post = async (path: string, body: string) => {
      const r = await a.ctx.app.inject({
        method: "POST",
        url: path,
        headers: { authorization: `Bearer ${await b.token(a.urn)}`, "content-type": "application/json", "a2a-version": "1.0" },
        payload: body,
      });
      return { status: r.statusCode, json: r.json() };
    };
    const huge = "a".repeat(17 * 1024 * 1024);
    const h = await post("/a2a/research/message:send", `{"message":{"messageId":"big-00001","role":"ROLE_USER","parts":[{"text":"${huge}"}]}}`);
    assert.equal(h.status, 413);
    assert.equal(reasonOf(h.json), "PAYLOAD_TOO_LARGE");
    const hj = await post("/a2a/research/jsonrpc", `{"jsonrpc":"2.0","id":1,"method":"SendMessage","params":{"x":"${huge}"}}`);
    assert.equal(hj.status, 413);
    assert.equal(hj.json.error.code, -31413);
    // A file at the contract's limit fits.
    const file = Buffer.alloc(12 * 1024 * 1024, 1).toString("base64");
    const ok = await send(b, "research", { ...msg("x"), parts: [{ text: "files" }, { raw: file, filename: "max.bin", mediaType: "application/octet-stream" }] });
    assert.equal(ok.status, 200, ok.text.slice(0, 300));
    assert.equal(ok.json.task.status.state, "TASK_STATE_COMPLETED");
    // L-7.
    const orig = (a.ctx.a2a as any).jobOf;
    (a.ctx.a2a as any).jobOf = () => {
      throw new Error("internal-detail-do-not-leak");
    };
    try {
      const f = await send(b, "research", msg("echo fails"));
      assert.equal(f.json.task.status.state, "TASK_STATE_FAILED");
      assert.ok(!f.text.includes("internal-detail-do-not-leak"));
    } finally {
      (a.ctx.a2a as any).jobOf = orig;
    }
  } finally {
    await s.close();
  }
});

test("review L-8: calls per trace are counted per caller — another caller's use of the same trace id does not use up mine", async () => {
  const s = await setup();
  try {
    const { a, b, d, send, msg } = s;
    const tp = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    const trace = { [A2A_EXT.trace]: { traceparent: tp, depth: 1 } };
    for (let i = 0; i < 64; i++)
      a.ctx.store.run(
        "INSERT INTO a2a_tasks(id,context_id,agent_id,caller,state,created,updated,trace_id,depth) VALUES(?,?,?,?,'TASK_STATE_COMPLETED',0,0,?,1)",
        `x-${i}`,
        "cx",
        "research",
        `contact:${d.card.id}`,
        "0af7651916cd43dd8448eb211c80319c",
      );
    assert.equal((await send(b, "research", msg("echo mine", { metadata: trace }))).json.task.status.state, "TASK_STATE_COMPLETED");
    const dd = (await send(d, "research", msg("echo theirs", { metadata: trace }))).json.task;
    assert.equal(dd.status.state, "TASK_STATE_REJECTED");
    assert.deepEqual(dd.status.message.parts[1], { data: { reason: "TRACE_CALLS_EXCEEDED" } });
  } finally {
    await s.close();
  }
});
