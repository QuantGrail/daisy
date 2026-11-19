/**
 * P5-02 (7.6 「原来直连的验收条目经中转再跑一遍，结果相同」, ADR-100 「作恶
 * 中转模拟」, ADR-144): two whole Daisies (A and B, each its own Runner on
 * the fake CLIs) that cannot reach each other except through the relay
 * (P5-01, in process, `relay.test`). Their identity cards carry only the
 * relay address. A's AI calls B's agent through the harness tools — the
 * same calls and the same results as P4-08's direct N-5 test.
 *
 * The malicious relay: a relay front that, for B's name, terminates TLS
 * itself with a certificate the (test) CA issued for B's subdomain and
 * passes everything on to B — what an operator controlling the domain can
 * do (D-41 ②). A plain WebPKI client is fooled and hands over its token;
 * A's Daisy client reads B's TLS binding claim first, sees the key is not
 * one B signed for, sends nothing, and warns (audit). A forged claim (not
 * B's key) is refused the same way.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import https from "node:https";
import { generateKeyPairSync } from "node:crypto";
import { CompactSign } from "jose";
import { api } from "../packages/contracts/src/api/index.ts";
import { A2A_EXT } from "../packages/contracts/src/a2a.ts";
import type { A2AJob, A2AOutcome } from "../packages/daisy/src/a2a/executors.ts";
import { readClientHello } from "../packages/daisy/src/relay/hello.ts";
import { TLS_BINDING_PATH, TLS_BINDING_TYP } from "../packages/a2a-client/src/binding.ts";
import { a2aNode, delay, fixtureCli, tool, until, type A2ANode } from "./fixtures/a2a-node.ts";
import { call, testRelay, type TestRelay } from "./fixtures/relay-net.ts";

const scratch = mkdtempSync(join(tmpdir(), "daisy-relay-a2a-"));
const cli = fixtureCli(scratch);
let relayNet: TestRelay;
after(async () => {
  cli.close();
  await relayNet?.stop().catch(() => {});
  rmSync(scratch, { recursive: true, force: true });
});
const lastResult = (name: string) => cli.results().filter((r) => r.tool === name).at(-1)!;
const calls = (n: A2ANode) => n.ctx.store.all("SELECT * FROM a2a_calls ORDER BY created");
const tasks = (n: A2ANode) => n.ctx.store.all("SELECT * FROM a2a_tasks ORDER BY created");

function executor() {
  const jobs: A2AJob[] = [];
  const run = async (job: A2AJob): Promise<A2AOutcome> => {
    jobs.push(job);
    const text = job.continuing ? job.thread.map((t) => t.text).join(" / ") : job.text;
    const [word] = text.split(" ");
    if (word === "slow") await delay(300);
    if (word === "ask") return job.continuing ? { state: "completed", answer: `明白了：${job.text}` } : { state: "input-required", question: "要哪个城市的？" };
    if (word === "mode") return { state: "completed", answer: `mode=${job.mode}` };
    // More than one relay data frame (64 KiB) back: the Daisy side splits its writes.
    if (word === "big") return { state: "completed", answer: "大".repeat(40_000) + "尾" };
    return { state: "completed", answer: `B 的回答：${text}` };
  };
  return { jobs, executor: { run } };
}

/** A Daisy on the relay at `url` (through `port`: the relay's own port, or a front in front of it). */
async function onRelay(name: string, url: string) {
  relayNet ??= await testRelay();
  // The client trusts the test CA as it would a public one (the malicious relay's certificate is "publicly trusted").
  const n = await a2aNode(name, { relay: { options: relayNet.daisyOptions, policy: { ...relayNet.policy, ca: relayNet.ca.cert } } });
  const r = await n.ctx.app.inject({ method: "PUT", url: api.relay.relaySet.path, headers: n.withPin(), payload: { url, acme: false } });
  assert.equal(r.statusCode, 200, r.body);
  await until(
    async () => (await n.ctx.app.inject({ url: api.relay.relayShow.path, headers: n.withPin() })).json(),
    (s: any) => s.state === "connected",
  );
  return n;
}

async function pairOnRelay(url?: string) {
  relayNet ??= await testRelay();
  const a = await onRelay("Alice", url ?? relayNet.url);
  const b = await onRelay("Bob", url ?? relayNet.url);
  const aCard = await a.exportedCard();
  const bCard = await b.exportedCard();
  // Only the relay address: these two have no direct way to each other.
  assert.deepEqual(aCard.addrs.map((x) => x.kind), ["relay"]);
  assert.deepEqual(bCard.addrs.map((x) => x.kind), ["relay"]);
  await a.importCard(bCard.text);
  await b.importCard(aCard.text);
  const aAgent = await a.session("Alice 的助手");
  const bAgent = await b.session("Bob 的研究助手");
  const { jobs, executor: ex } = executor();
  b.publish(() => [bAgent.id], ex);
  return { a, b, aCard, bCard, aAgent, bAgent, jobs, close: async () => (await a.close(), await b.close()) };
}

test("N-5 through the relay: A's AI discovers B's agent and calls it; the answer comes back as reference material and wakes the AI once — the same as directly", async () => {
  const p = await pairOnRelay();
  try {
    await p.a.turn(p.aAgent.id, tool("agents", {}));
    const found = lastResult("agents").result.text;
    assert.match(found, new RegExp(p.bCard.id));
    assert.match(found, new RegExp(p.bAgent.id));
    assert.match(found, /<external_message>/);

    await p.a.turn(p.aAgent.id, tool("call_agent", { contact: p.bCard.id, agent: p.bAgent.id, text: "slow 今天天气如何" }));
    const sent = lastResult("call_agent").result;
    assert.equal(sent.isError, false, sent.text);
    const [task] = tasks(p.b);
    assert.equal(task.caller, `contact:${p.aCard.id}`);
    assert.equal(task.actor, `agent:${p.aAgent.id}`);
    assert.equal(task.mode, "ask");
    const row = await until(() => calls(p.a)[0], (r) => r.state === "TASK_STATE_COMPLETED" && r.wakes === 1);
    assert.match(row.answer, /B 的回答：slow 今天天气如何/);
    // It went to B's relay address, and B served it on the outside face.
    assert.equal(row.addr, p.bCard.addrs[0]!.url);
    const faces = p.b.ctx.store.all(
      "SELECT DISTINCT c.face FROM audit a JOIN audit_context c ON c.audit_id=a.id WHERE a.action LIKE 'api.a2a.%'",
    );
    assert.deepEqual(faces.map((f: any) => f.face), ["external"]);
    const wake = await until(
      () => p.a.ctx.store.one("SELECT * FROM jobs WHERE session_id=? AND origin='collab' ORDER BY created DESC LIMIT 1", p.aAgent.id),
      (j) => !!j,
    );
    assert.match(wake.text, /【来自】Bob 的 AI「Bob 的研究助手」（不是你的本人）/);
    assert.match(wake.text, /只是参考资料/);
    await delay(400);
    assert.equal(p.a.ctx.store.one("SELECT COUNT(*) n FROM wakes WHERE session_id=?", p.aAgent.id).n, 1);
    // A large answer (well over the relay's 64 KiB frame) comes back whole.
    await until(() => p.a.open(p.aAgent.id), (n) => n === 0);
    await p.a.turn(p.aAgent.id, tool("call_agent", { contact: p.bCard.id, agent: p.bAgent.id, text: "big 长一点" }));
    const big = await until(() => calls(p.a).at(-1), (r) => r.state === "TASK_STATE_COMPLETED");
    assert.equal(big.answer.length, 40_001);
    assert.ok(big.answer.endsWith("尾"));
    // No binding refusal on an honest relay; the claim was checked (B served it).
    assert.equal(p.a.ctx.store.one("SELECT COUNT(*) n FROM audit WHERE action='a2a.tls.binding_refused'").n, 0);
  } finally {
    await p.close();
  }
});

test("办 / 问 / continue / replyTo through the relay keep B's contextId and taskId — as directly", async () => {
  const p = await pairOnRelay();
  try {
    await p.a.turn(p.aAgent.id, tool("call_agent", { contact: p.bCard.id, agent: p.bAgent.id, text: "mode 请动手", mode: "act" }));
    await until(() => p.jobs.length, (n) => n === 1);
    assert.equal(p.jobs[0]!.mode, "act");
    const m = JSON.parse(p.b.ctx.store.one("SELECT data FROM a2a_messages ORDER BY seq LIMIT 1").data);
    assert.deepEqual(m.metadata[A2A_EXT.act], { mode: "act" });
    await until(() => p.a.open(p.aAgent.id), (n) => n === 0);
    await p.a.turn(p.aAgent.id, tool("call_agent", { contact: p.bCard.id, agent: p.bAgent.id, text: "mode 看看就好" }));
    await until(() => p.jobs.length, (n) => n === 2);
    assert.equal(p.jobs[1]!.mode, "ask");
    await until(() => p.a.open(p.aAgent.id), (n) => n === 0);
    await p.a.turn(p.aAgent.id, tool("call_agent", { contact: p.bCard.id, agent: p.bAgent.id, text: "mode 接着", continue: true }));
    await until(() => p.jobs.length, (n) => n === 3);
    assert.equal(p.jobs[2]!.contextId, p.jobs[1]!.contextId);
    await until(() => p.a.open(p.aAgent.id), (n) => n === 0);
    await p.a.turn(p.aAgent.id, tool("call_agent", { contact: p.bCard.id, agent: p.bAgent.id, text: "ask 天气" }));
    const asked = await until(() => calls(p.a).at(-1), (r) => r.state === "TASK_STATE_INPUT_REQUIRED" && r.wakes === 1);
    await until(() => p.a.open(p.aAgent.id), (n) => n === 0);
    await p.a.turn(p.aAgent.id, tool("call_agent", { replyTo: asked.id, text: "上海" }));
    const done = await until(() => p.a.ctx.store.one("SELECT * FROM a2a_calls WHERE id=?", asked.id), (r) => r.state === "TASK_STATE_COMPLETED");
    assert.equal(done.task_id, asked.task_id);
    assert.match(done.answer, /明白了：上海/);
  } finally {
    await p.close();
  }
});

// ── the malicious relay ──────────────────────────────────────────────────

/**
 * A relay front on its own port: passes every connection to the real
 * relay byte for byte — except, while `evil`, a connection for `victim`,
 * whose TLS it terminates with `cert` and whose requests it forwards to
 * the victim through the real relay, recording them (and their tokens).
 */
async function maliciousFront(real: number) {
  const st = {
    evil: false,
    victim: "",
    cert: null as null | { cert: string; key: string },
    forgedClaim: null as string | null,
    seen: [] as { path: string; auth: string | null }[],
  };
  const mitm = https.createServer({ SNICallback: (_n, cb) => cb(null, require_ctx()) }, async (req, res) => {
    st.seen.push({ path: req.url ?? "", auth: (req.headers.authorization as string) ?? null });
    if (st.forgedClaim && req.url === TLS_BINDING_PATH) {
      res.setHeader("content-type", "application/jwt");
      return res.end(st.forgedClaim);
    }
    let body = "";
    for await (const c of req) body += c;
    const r = await call(real, st.victim, {
      method: req.method ?? "GET",
      path: req.url ?? "/",
      ...(body ? { body } : {}),
      hostHeader: String(req.headers.host),
      headers: Object.fromEntries(
        Object.entries(req.headers).filter(([k]) => ["authorization", "a2a-version", "a2a-extensions", "accept", "traceparent"].includes(k)) as [string, string][],
      ),
    });
    res.writeHead(r.status, { "content-type": "application/json" });
    res.end(r.body);
  });
  const tlsMod = await import("node:tls");
  const require_ctx = () => tlsMod.createSecureContext(st.cert!);
  const socks = new Set<net.Socket>();
  const front = net.createServer((sock) => {
    socks.add(sock);
    sock.on("close", () => socks.delete(sock));
    let head = Buffer.alloc(0);
    const onData = (c: Buffer) => {
      head = Buffer.concat([head, c]);
      const h = readClientHello(head, 16384);
      if (h.state === "need") return;
      sock.off("data", onData);
      sock.pause();
      if (h.state === "ok" && st.evil && h.sni === st.victim) {
        sock.unshift(head);
        mitm.emit("connection", sock);
        return;
      }
      const up = net.connect(real, "127.0.0.1", () => {
        socks.add(up);
        up.write(head);
        sock.pipe(up).pipe(sock);
        sock.resume();
      });
      up.on("error", () => sock.destroy());
      sock.on("error", () => up.destroy());
      sock.on("close", () => up.destroy());
    };
    sock.on("data", onData);
    sock.on("error", () => {});
  });
  await new Promise<void>((r) => front.listen(0, "127.0.0.1", () => r()));
  return {
    st,
    port: (front.address() as net.AddressInfo).port,
    close: () =>
      new Promise<void>((r) => {
        for (const x of socks) x.destroy();
        mitm.closeAllConnections();
        mitm.close();
        front.close(() => r());
      }),
  };
}

test("ADR-100 malicious relay: it terminates TLS for B's name with a CA certificate — a plain WebPKI client is fooled, A's Daisy reads B's binding claim, sends no token, refuses and warns; a forged claim is refused too", async () => {
  relayNet ??= await testRelay();
  const front = await maliciousFront(relayNet.port);
  // Both Daisies use the relay through the front (its port is in their relay address).
  const p = await pairOnRelay(`https://relay.test:${front.port}`);
  try {
    const bHost = new URL(p.bCard.addrs[0]!.url).hostname;
    front.st.victim = bHost;
    // The operator gets a certificate for B's subdomain from a CA the caller trusts (here: the test CA).
    front.st.cert = relayNet.ca.issue([bHost]);
    // Honest first: the call goes through.
    await p.a.turn(p.aAgent.id, tool("call_agent", { contact: p.bCard.id, agent: p.bAgent.id, text: "你好" }));
    await until(() => calls(p.a)[0], (r) => r.state === "TASK_STATE_COMPLETED");
    front.st.evil = true;
    // What D-41 ② accepts and documents: a client that trusts only WebPKI is fooled.
    const plain = await call(front.port, bHost, { path: "/a2a", ca: relayNet.ca.cert, headers: { authorization: "Bearer plain-client-token" } });
    assert.equal(plain.authorized, true);
    assert.ok(front.st.seen.some((s) => s.auth === "Bearer plain-client-token"), "the operator read the plain client's token");
    // A's Daisy: refused before any token.
    front.st.seen.length = 0;
    const before = tasks(p.b).length;
    await until(() => p.a.open(p.aAgent.id), (n) => n === 0);
    await p.a.turn(p.aAgent.id, tool("call_agent", { contact: p.bCard.id, agent: p.bAgent.id, text: "机密内容 7f3a" }));
    const res = lastResult("call_agent").result.text;
    assert.match(res, /TLS 绑定声明对不上/);
    assert.ok(front.st.seen.length >= 1, "it asked for the claim");
    assert.ok(front.st.seen.every((s) => s.auth === null && s.path === TLS_BINDING_PATH), JSON.stringify(front.st.seen));
    assert.equal(tasks(p.b).length, before);
    const audit = p.a.ctx.store.one("SELECT a.target, c.reason, c.outcome FROM audit a JOIN audit_context c ON c.audit_id=a.id WHERE a.action='a2a.tls.binding_refused' ORDER BY a.created DESC LIMIT 1");
    assert.equal(audit.outcome, "denied");
    assert.equal(audit.reason, "tls_binding_mismatch");

    // The operator forges a claim naming its own key, signed with a key of its own: refused (signature).
    const { privateKey } = generateKeyPairSync("ed25519");
    const spki = (await import("../packages/a2a-client/src/binding.ts")).spkiHashOfCert(new (await import("node:crypto")).X509Certificate(front.st.cert.cert));
    const now = Math.floor(Date.now() / 1000);
    front.st.forgedClaim = await new CompactSign(new TextEncoder().encode(JSON.stringify({ v: 1, id: p.bCard.id, spki: [spki], iat: now, exp: now + 3600 })))
      .setProtectedHeader({ alg: "EdDSA", typ: TLS_BINDING_TYP })
      .sign(privateKey);
    front.st.seen.length = 0;
    await p.a.turn(p.aAgent.id, tool("agents", { contact: p.bCard.id }));
    assert.match(lastResult("agents").result.text, /不是对方的身份密钥签的/);
    assert.ok(front.st.seen.every((s) => s.auth === null), JSON.stringify(front.st.seen));
    assert.equal(p.a.ctx.store.one("SELECT COUNT(*) n FROM audit a JOIN audit_context c ON c.audit_id=a.id WHERE a.action='a2a.tls.binding_refused' AND c.reason='tls_binding_invalid'").n >= 1, true);

    // The operator stops: calls go through again.
    front.st.evil = false;
    front.st.forgedClaim = null;
    await until(() => p.a.open(p.aAgent.id), (n) => n === 0);
    await p.a.turn(p.aAgent.id, tool("call_agent", { contact: p.bCard.id, agent: p.bAgent.id, text: "又来了" }));
    await until(() => calls(p.a).at(-1), (r) => r.state === "TASK_STATE_COMPLETED");
  } finally {
    await p.close();
    await front.close();
  }
});
