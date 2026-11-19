/**
 * P5-02 Daisy 的中转连接 (总纲 5.9, 7.6, D-05, D-41, ADR-100, ADR-101,
 * ADR-143, ADR-144): a whole Daisy (createApp) and the relay program
 * (P5-01) in one process, on the fake domain `relay.test` with a test CA —
 * no DNS, no network, no real ACME.
 *
 * Refusals first: choosing a relay needs the PIN and is never the AI's;
 * a relay stream reaches the outside face only — no local-face credential,
 * no code-less local session, no loopback trust, no closed switch, no
 * Host of the local face. Then: connected and the address in the identity
 * card; the TLS binding claim; N-4 (the relay restarts, Daisy comes back
 * within 30 s); off removes the address and drops the streams; a PIN reset
 * turns the relay off.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { api } from "../packages/contracts/src/api/index.ts";
import { verifyBindingClaim, TLS_BINDING_PATH } from "../packages/a2a-client/src/binding.ts";
import { subdomainOfIdentityId } from "../packages/relay/src/protocol.ts";
import { daisy, runningTurn, type Daisy } from "./fixtures/daisy-with-issuer.ts";
import { peerDaisy } from "./fixtures/peer-daisy.ts";
import { call, handshake, testRelay, until, sleep, DOMAIN, localLookup, type TestRelay } from "./fixtures/relay-net.ts";
import { startRelay } from "../packages/relay/src/relay.ts";
import { makeLogger } from "../packages/relay/src/log.ts";
import { TestCA } from "../packages/relay/tests/helpers/pki.ts";

let net: TestRelay;
const opened: Daisy[] = [];
after(async () => {
  for (const d of opened) await d.close().catch(() => {});
  await net?.stop().catch(() => {});
});

async function relayDaisy(): Promise<Daisy> {
  net ??= await testRelay();
  const d = await daisy({ relay: net.daisyOptions });
  opened.push(d);
  return d;
}

const relayStatus = async (d: Daisy) =>
  (await d.ctx.app.inject({ url: api.relay.relayShow.path, headers: d.asCli })).json();

async function connect(d: Daisy, body: Record<string, unknown> = {}) {
  const r = await d.ctx.app.inject({
    method: "PUT",
    url: api.relay.relaySet.path,
    headers: d.withPin(),
    payload: { url: net.url, acme: false, ...body },
  });
  assert.equal(r.statusCode, 200, r.body);
  const st = await until(() => relayStatus(d), (s) => s.state === "connected", 10_000, "connected");
  const host = new URL(st.address).hostname;
  return { st, host };
}

// ── refusals first ────────────────────────────────────────────────────────

test("choosing a relay lets the world reach the outside face: the PIN on every channel, never the AI's credential; a bad address is refused; turning it off takes the PIN too (5.10)", async () => {
  const d = await relayDaisy();
  const put = (headers: Record<string, string>, payload: unknown = { url: net.url, acme: false }) =>
    d.ctx.app.inject({ method: "PUT", url: api.relay.relaySet.path, headers, payload: payload as any });
  // No PIN grant: refused, nothing saved, nothing connected.
  const noPin = await put(d.asCli);
  assert.equal(noPin.statusCode, 403);
  assert.equal(noPin.json().code, "pin_required");
  // A web session without a PIN grant neither.
  const web = await put({ authorization: `Bearer ${d.ctx.issueToken("local")}` });
  assert.equal(web.statusCode, 403);
  assert.equal(web.json().code, "pin_required");
  // The AI's working credential: never (it is not a channel that may let anyone in).
  const t = await runningTurn(d);
  const ai = await put({ authorization: `Bearer ${t.ai}` });
  assert.equal(ai.statusCode, 403);
  assert.ok(["channel_not_allowed", "insufficient_scope"].includes(ai.json().code), ai.body);
  // The AI cannot read it either (daisy:manage).
  const aiRead = await d.ctx.app.inject({ url: api.relay.relayShow.path, headers: { authorization: `Bearer ${t.ai}` } });
  assert.equal(aiRead.statusCode, 403);
  assert.equal((await relayStatus(d)).enabled, false);
  // Addresses that are not a relay's.
  for (const url of ["http://relay.test", "https://127.0.0.1", "https://relay.test/path", "https://u:p@relay.test", "localhost", "https://relay"]) {
    const r = await put(d.withPin(), { url, acme: false });
    assert.equal(r.statusCode, 400, url);
    assert.equal(r.json().code, "relay_invalid", url);
  }
  const badDir = await put(d.withPin(), { url: net.url, acmeDirectory: "http://acme.example/directory" });
  assert.equal(badDir.statusCode, 400);
  assert.equal((await relayStatus(d)).enabled, false);
  assert.equal(d.ctx.store.one("SELECT COUNT(*) n FROM audit WHERE action='relay.set'").n, 0);
  // With the PIN: on. Off: the PIN as well (the AI on the command line must not cut the owner off).
  await connect(d);
  const offNoPin = await d.ctx.app.inject({ method: "DELETE", url: api.relay.relayOff.path, headers: d.asCli });
  assert.equal(offNoPin.statusCode, 403);
  assert.equal(offNoPin.json().code, "pin_required");
  const offAi = await d.ctx.app.inject({ method: "DELETE", url: api.relay.relayOff.path, headers: { authorization: `Bearer ${t.ai}` } });
  assert.equal(offAi.statusCode, 403);
  assert.equal((await relayStatus(d)).state, "connected");
  const off = await d.ctx.app.inject({ method: "DELETE", url: api.relay.relayOff.path, headers: d.withPin() });
  assert.equal(off.statusCode, 200, off.body);
  assert.equal(off.json().enabled, false);
  assert.equal(off.json().state, "off");
});

test("ADR-101: a request through the relay is the outside face's — local credentials, a code-less local session, loopback trust, a closed switch and the local face's Host are all refused", async () => {
  const d = await relayDaisy();
  const { host } = await connect(d);
  const via = (path: string, o: Parameters<typeof call>[2] = {}) => call(net.port, host, { path, ...o });
  // The command line's credential (local face only).
  const cli = await via("/api/me", { headers: d.asCli });
  assert.equal(cli.status, 401, cli.body);
  // The AI's working credential (local face only), during its running turn.
  const t = await runningTurn(d);
  const ai = await via(`/api/sessions/${t.own}`, { headers: { authorization: `Bearer ${t.ai}` } });
  assert.equal(ai.status, 401, ai.body);
  // A local web session (sessions are per face).
  const local = await via("/api/me", { headers: { authorization: `Bearer ${d.ctx.issueToken("local")}` } });
  assert.equal(local.status, 401);
  // A web session without a one-time code: the loopback / same-account trust is the local face's only.
  const codeless = await via("/api/web/session", { method: "POST", body: {}, headers: { origin: `https://${host}:${net.port}` } });
  assert.equal(codeless.status, 401, codeless.body);
  assert.equal(codeless.json.code, "passcode_required");
  // The local face's own Host through the relay (DNS rebinding-style): refused.
  const lh = await via("/api/health", { hostHeader: "127.0.0.1:29311" });
  assert.equal(lh.status, 403);
  assert.equal(lh.json.code, "host_not_allowed");
  // An outside web session works there — it is the outside face …
  const ext = { authorization: `Bearer ${d.ctx.issueToken("external")}` };
  const me = await via("/api/me", { headers: ext });
  assert.equal(me.status, 200, me.body);
  assert.equal(me.json.face, "external");
  // … with the outside face's switches: the terminal and shell are off.
  const term = await via(`/api/sessions/${t.own}/operations/terminal`, { method: "POST", body: {}, headers: ext });
  assert.equal(term.status, 403, term.body);
  assert.equal(term.json.code, "external_off");
  const shell = await via(`/api/sessions/${t.own}/shell`, { method: "POST", body: { command: "id" }, headers: ext });
  assert.equal(shell.status, 403);
  assert.equal(shell.json.code, "external_off");
  // A route outside the table is refused there too; health is public.
  assert.equal((await via("/api/health")).status, 200);
  // A visitor (a contact's token) reaches only the A2A entry.
  const b = await peerDaisy("B");
  try {
    const imp = await d.ctx.app.inject({ method: "POST", url: api.contacts.contactImport.path, headers: d.withPin(), payload: { card: b.text } });
    assert.equal(imp.statusCode, 200, imp.body);
    const tok = await b.token(d.urn);
    const vis = await via("/api/me", { headers: { authorization: `Bearer ${tok}` } });
    assert.equal(vis.status, 403);
    assert.equal(vis.json.code, "a2a_only");
    const dir = await via("/a2a", { headers: { authorization: `Bearer ${await b.token(d.urn)}` } });
    assert.equal(dir.status, 200, dir.body);
  } finally {
    b.close();
  }
  // Every refusal above was audited as the outside face.
  const faces = d.ctx.store
    .all("SELECT c.face FROM audit a JOIN audit_context c ON c.audit_id=a.id WHERE c.outcome='denied' ORDER BY a.created DESC LIMIT 8")
    .map((r: any) => r.face);
  assert.ok(faces.length && faces.every((f: string) => f === "external"), JSON.stringify(faces));
});

test("a stream the relay hands over is held to the relay address: another server name never gets a certificate, and nothing reaches the local face's server", async () => {
  const d = await relayDaisy();
  await connect(d);
  const net_ = await import("node:net");
  const tls = await import("node:tls");
  let localConnections = 0;
  const count = () => localConnections++;
  d.ctx.app.server.on("connection", count);
  // A loopback socket pair; the server end is handed over as the relay would.
  const srv = net_.createServer((s) => d.ctx.access.faces.injectRelay(s, "203.0.113.9"));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  try {
    const port = (srv.address() as any).port;
    for (const servername of ["evil.example", `x${"a".repeat(31)}.${DOMAIN}`, undefined]) {
      const r = await new Promise<string>((resolve) => {
        const s = tls.connect({ host: "127.0.0.1", port, ...(servername ? { servername } : {}), rejectUnauthorized: false });
        s.on("secureConnect", () => {
          s.destroy();
          resolve("connected");
        });
        s.on("error", (e: any) => resolve(String(e.code ?? e.message)));
      });
      assert.notEqual(r, "connected", String(servername));
    }
    assert.equal(localConnections, 0);
  } finally {
    d.ctx.app.server.off("connection", count);
    await new Promise<void>((r) => srv.close(() => r()));
  }
});

// ── connected ────────────────────────────────────────────────────────────

test("connected: the address is https://<first 32 characters of the identity number>.relay.test, in the identity card (kind relay) and the agent cards; the TLS binding claim names the key the caller sees", async () => {
  const d = await relayDaisy();
  const { st, host } = await connect(d);
  const id = d.ctx.access.ai.self.kid;
  assert.equal(host, `${subdomainOfIdentityId(id)}.${DOMAIN}`);
  assert.equal(host.split(".")[0], id.slice(0, 32));
  assert.equal(st.address, `https://${host}:${net.port}`);
  assert.equal(st.cert.kind, "self-signed");
  assert.match(st.cert.note, /只有 Daisy 之间能用/);
  // The identity card carries it (no outside face listening: only it).
  const card = (await d.ctx.app.inject({ url: api.contacts.contactExport.path, headers: d.withPin() })).json();
  assert.deepEqual(card.addrs, [{ kind: "relay", url: st.address }]);
  assert.match(card.text, new RegExp(st.address.replace(/[.]/g, "\\.")));
  // The passcode applies now (reachable from elsewhere).
  assert.equal(d.ctx.access.passcodeOn(), true);
  // Through the relay: the claim, verified with the identity key, names the certificate's key.
  const r = await call(net.port, host, { path: TLS_BINDING_PATH });
  assert.equal(r.status, 200, r.body);
  const claim = await verifyBindingClaim(r.body, d.ctx.access.ai.self.publicJwk as any);
  assert.equal(claim.id, id);
  assert.ok(claim.spki.includes(r.spki), "the claim names the relay address's key");
  // The served certificate is for the relay host, with an ECDSA P-256 key (ADR-100).
  const pem = d.ctx.relay.current.certs!.certificate!;
  const x = new X509Certificate(pem);
  assert.ok(x.checkHost(host));
  assert.equal(x.publicKey.asymmetricKeyType, "ec");
  assert.equal((x.publicKey.asymmetricKeyDetails as any).namedCurve, "prime256v1");
  // The relay saw only the SNI: its logs carry no path, no claim.
  assert.ok(!net.logs.some((l) => l.includes(TLS_BINDING_PATH)));
});

test("N-4 (Daisy's side): the relay restarts — Daisy is told 1012, backs off, and is connected again within 30 s on the same address; calls work again", async () => {
  const d = await relayDaisy();
  const { st, host } = await connect(d);
  assert.equal((await call(net.port, host, { path: "/api/health" })).status, 200);
  const t0 = Date.now();
  await net.stop();
  await until(() => relayStatus(d), (s) => s.state !== "connected", 5000, "noticed");
  const down = await relayStatus(d);
  assert.match(String(down.lastError), /重启|断|连不上/);
  await sleep(1500);
  await net.restart();
  const back = await until(() => relayStatus(d), (s) => s.state === "connected", 30_000, "reconnected");
  const ms = Date.now() - t0;
  assert.ok(ms < 30_000, `back in ${ms} ms`);
  assert.equal(back.address, st.address);
  assert.equal((await call(net.port, host, { path: "/api/health" })).status, 200);
});

test("the ping watchdog: a relay that stops pinging is left after 2.5 intervals and Daisy reconnects", async () => {
  const d = await relayDaisy();
  await connect(d);
  const link = d.ctx.relay.current.link!;
  // Pretend the relay announced a 400 ms interval and then went silent (no pings arrive).
  (link as any).pingMs = 400;
  (link as any).arm();
  const reconnects = until(() => relayStatus(d), (s) => s.state !== "connected", 3000, "watchdog");
  const s = await reconnects;
  assert.match(String(s.lastError), /心跳/);
  await until(() => relayStatus(d), (x) => x.state === "connected", 10_000, "back");
});

test("off: the address leaves the identity card, the relay says offline (handshake refused), and the relay Host is not this Daisy's any more", async () => {
  const d = await relayDaisy();
  const { st, host } = await connect(d);
  const off = await d.ctx.app.inject({ method: "DELETE", url: api.relay.relayOff.path, headers: d.withPin() });
  assert.equal(off.statusCode, 200);
  assert.equal(off.json().address, null);
  const card = (await d.ctx.app.inject({ url: api.contacts.contactExport.path, headers: d.withPin() })).json();
  assert.deepEqual(card.addrs, []);
  const h = await until(() => handshake(net.port, host), (r) => !r.ok, 5000, "offline");
  assert.equal(h.ok, false);
  // On the local face too, the relay host is nobody's now.
  const r = await d.ctx.app.inject({ url: "/api/health", headers: { host: new URL(st.address).host } });
  assert.equal(r.statusCode, 403);
  assert.equal(d.ctx.access.passcodeOn(), false);
  assert.equal(d.ctx.store.one("SELECT COUNT(*) n FROM audit WHERE action='relay.off'").n, 1);
});

test("T-9: a PIN reset turns the relay off with the outside face", async () => {
  const d = await relayDaisy();
  await connect(d);
  d.ctx.access.revocations.runAll();
  await until(() => relayStatus(d), (s) => s.state === "off" && s.enabled === false, 5000, "off");
});

test("PROTOCOL.md 1.1: a relay whose operator does not admit this Daisy (4403) — refused, said so in the status, and not tried again", async () => {
  const ca = new TestCA("Allow-list Relay CA");
  const own = ca.issue([DOMAIN]);
  const r = await startRelay({ domain: DOMAIN, host: "127.0.0.1", port: 0, cert: own.cert, key: own.key, logger: makeLogger("info", () => {}), allowIdentities: ["a".repeat(52)] });
  const d = await daisy({ relay: { transport: { link: { ca: ca.cert, lookup: localLookup } }, limits: { backoffBaseMs: 50, backoffMaxMs: 100 } } });
  opened.push(d);
  try {
    const put = await d.ctx.app.inject({ method: "PUT", url: api.relay.relaySet.path, headers: d.withPin(), payload: { url: `https://${DOMAIN}:${r.port}`, acme: false } });
    assert.equal(put.statusCode, 200, put.body);
    const st = await until(() => relayStatus(d), (s) => s.state === "refused", 5000, "refused");
    assert.match(st.lastError, /允许名单/);
    assert.equal(st.retryAt, null);
    await sleep(600);
    assert.equal((await relayStatus(d)).state, "refused");
  } finally {
    await r.close();
  }
});

test("`daisy status`: connected or not, the address, and what the certificate allows (self-signed: Daisy-to-Daisy only)", async () => {
  const { relayLine } = await import("../packages/daisy/src/cli/local/commands.ts");
  assert.match(relayLine({ enabled: false }), /未选/);
  const base = { enabled: true, relay: "https://relay.example", address: "https://abc.relay.example", retryAt: null, lastError: null };
  const self = relayLine({ ...base, state: "connected", cert: { kind: "self-signed", lastError: "证书机构说不" } });
  assert.match(self, /已连上/);
  assert.match(self, /经中转只有 Daisy 之间能用/);
  assert.match(self, /证书机构说不/);
  assert.match(relayLine({ ...base, state: "connected", cert: { kind: "acme" } }), /证书机构签发/);
  assert.match(relayLine({ ...base, state: "waiting", retryAt: Date.now() + 3000, lastError: "中转在重启", cert: { kind: "acme" } }), /没连上，\d+ 秒后重试（https:\/\/relay\.example）：中转在重启/);
  assert.match(relayLine({ ...base, state: "refused", lastError: "不在允许名单里", cert: { kind: "acme" } }), /被中转拒绝（https:\/\/relay\.example）：不在允许名单里/);
});

// ── security review of P5-02 ─────────────────────────────────────────────

test("review M-1: relay callers never drain the local face's rate-limit buckets — the relay's word about the caller is kept apart, never `remoteAddress`", async () => {
  const d = await relayDaisy();
  const { host } = await connect(d);
  // The test relay reports every caller as 127.0.0.1 — what a lying relay (or a local proxy) would say.
  const statuses: number[] = [];
  for (let i = 0; i < 24; i++)
    statuses.push((await call(net.port, host, { method: "POST", path: "/api/web/session", body: { code: "B".repeat(22) } })).status);
  assert.ok(statuses.includes(429), `the relay callers have their own limit: ${statuses.join(",")}`);
  // The local face's own bucket is untouched: a bad code is still just a bad code.
  const local = await d.ctx.app.inject({ method: "POST", url: "/api/web/session", payload: { code: "A".repeat(22) } });
  assert.equal(local.statusCode, 401, local.body);
  assert.equal(local.json().code, "code_invalid");
});

test("review L-3 (decided: off): the terminal, shell and directory switches never apply through the relay, even when the outside face has them on", async () => {
  const d = await relayDaisy();
  const { host } = await connect(d);
  // The owner once turned them on for the direct listener (config only; no listener needed for this).
  const { writeAccessConfig } = await import("../packages/daisy/src/access/config.ts");
  writeAccessConfig(d.dir, (c) => ({ ...c, external: { ...c.external, allow: { terminal: true, shell: true, browse: true } } }));
  const t = await runningTurn(d);
  const ext = { authorization: `Bearer ${d.ctx.issueToken("external")}` };
  const term = await call(net.port, host, { method: "POST", path: `/api/sessions/${t.own}/operations/terminal`, body: {}, headers: ext });
  assert.equal(term.status, 403, term.body);
  assert.equal(term.json.code, "external_off");
  const shell = await call(net.port, host, { method: "POST", path: `/api/sessions/${t.own}/shell`, body: { command: "id" }, headers: ext });
  assert.equal(shell.status, 403);
  assert.match(shell.json.error, /经中转/);
  // Turning the relay off ends the outside face's web sessions (as turning the outside face off does).
  const off = await d.ctx.app.inject({ method: "DELETE", url: api.relay.relayOff.path, headers: d.withPin() });
  assert.equal(off.statusCode, 200);
  const me = await d.ctx.app.inject({ url: "/api/me", headers: ext });
  assert.equal(me.statusCode, 401);
});

test("review L-2: the PIN reset turns the relay off for real — saved off first (a failed write fails the reset), the connection gone at once", async () => {
  const d = await relayDaisy();
  await connect(d);
  d.ctx.access.revocations.runAll();
  // At once, not eventually: the hook is synchronous.
  assert.equal(d.ctx.relay.config().enabled, false);
  assert.equal(d.ctx.access.faces.relay, null);
  await until(() => relayStatus(d), (s) => s.state === "off", 3000, "off");
  // The relay's setting cannot be written: the reset fails (it does not claim the relay is off) —
  // and the relay is disconnected all the same.
  await connect(d);
  const save = d.ctx.relay.save.bind(d.ctx.relay);
  d.ctx.relay.save = () => {
    throw new Error("disk full");
  };
  try {
    assert.throws(() => d.ctx.access.revocations.runAll(), /disk full|relay/);
    assert.equal(d.ctx.access.faces.relay, null, "disconnected even so");
  } finally {
    d.ctx.relay.save = save;
  }
});
