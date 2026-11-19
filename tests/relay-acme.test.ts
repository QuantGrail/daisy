/**
 * P5-02 (ADR-100 B1 / B2, ADR-144 §5): the relay address's certificate —
 * ACME TLS-ALPN-01 through the relay (an in-process ACME stand-in on
 * `acme.test`, tests/fixtures/fake-acme.ts; no real CA, no network), the
 * same ECDSA P-256 key kept across renewals (the TLS binding claim stays
 * true), ARI-driven renewal with `replaces`, and the self-signed fallback
 * when the CA says no. Also the pure pieces: the ClientHello reader that
 * tells a CA's check from a call, and the X.509 pieces (x509.ts).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import tls from "node:tls";
import net from "node:net";
import { createHash, generateKeyPairSync, X509Certificate } from "node:crypto";
import { api } from "../packages/contracts/src/api/index.ts";
import { readClientHello } from "../packages/daisy/src/relay/hello.ts";
import { alpnChallengeCert, alpnDigestOf, ariCertId, csrDer, readCsr, selfSignedCert } from "../packages/daisy/src/relay/x509.ts";
import { parseRelayUrl, acmeUsable, DEFAULT_ACME_DIRECTORY } from "../packages/daisy/src/relay/config.ts";
import { verifyBindingClaim, TLS_BINDING_PATH } from "../packages/a2a-client/src/binding.ts";
import { daisy, type Daisy } from "./fixtures/daisy-with-issuer.ts";
import { call, testRelay, until, localLookup, type TestRelay } from "./fixtures/relay-net.ts";
import { fakeAcme, type FakeAcme } from "./fixtures/fake-acme.ts";

let net_: TestRelay;
let acme: FakeAcme;
const opened: Daisy[] = [];
after(async () => {
  for (const d of opened) await d.close().catch(() => {});
  await acme?.close();
  await net_?.stop().catch(() => {});
});

async function acmeDaisy() {
  net_ ??= await testRelay();
  acme ??= await fakeAcme({ relayPort: net_.port });
  const d = await daisy({
    relay: { transport: { link: net_.daisyOptions.transport.link, acme: { ca: acme.tlsCa, lookup: localLookup } }, limits: net_.daisyOptions.limits },
  });
  opened.push(d);
  return d;
}
const status = async (d: Daisy) => (await d.ctx.app.inject({ url: api.relay.relayShow.path, headers: d.asCli })).json();

test("ACME TLS-ALPN-01 through the relay: self-signed at once, then the CA's certificate for the same key — third-party clients trust it, the binding claim still holds", async () => {
  const d = await acmeDaisy();
  const r = await d.ctx.app.inject({ method: "PUT", url: api.relay.relaySet.path, headers: d.withPin(), payload: { url: net_.url, acmeDirectory: acme.directory } });
  assert.equal(r.statusCode, 200, r.body);
  const first = r.json();
  assert.equal(first.cert.acme.directory, acme.directory);
  const st = await until(() => status(d), (s) => s.state === "connected" && s.cert.kind === "acme", 20_000, "acme");
  const host = new URL(st.address).hostname;
  assert.match(st.cert.note, /第三方 A2A 客户端/);
  assert.equal(st.cert.lastError, null);
  // The CA checked it through the relay with acme-tls/1 and found its digest.
  const v = acme.st.validations.at(-1)!;
  assert.deepEqual([v.host, v.alpn, v.ok], [host, "acme-tls/1", true]);
  // Every request after the first badNonce went with the account's kid.
  assert.ok(acme.st.requests.filter((q) => q.path !== "/new-account").every((q) => q.kid));
  // A caller trusting the CA (not the self-signed one) is satisfied; the key is the same as before.
  const c = await call(net_.port, host, { path: TLS_BINDING_PATH, ca: acme.root });
  assert.equal(c.authorized, true);
  const claim = await verifyBindingClaim(c.body, d.ctx.access.ai.self.publicJwk as any);
  assert.ok(claim.spki.includes(c.spki));
  // A CA check while no challenge is open gets nothing (and never reaches the outside face).
  const stray = await new Promise<string>((resolve) => {
    const s = tls.connect({ host: "127.0.0.1", port: net_.port, servername: host, ALPNProtocols: ["acme-tls/1"], rejectUnauthorized: false });
    s.on("secureConnect", () => (s.destroy(), resolve("connected")));
    s.on("error", (e: any) => resolve(String(e.code ?? e.message)));
    s.on("close", () => resolve("closed"));
  });
  assert.notEqual(stray, "connected");
});

test("renewal: ARI says now — a new certificate, ordered with `replaces` = the old one's ARI id, the same key; a CA that fails the challenge leaves the current certificate and tries again later", async () => {
  const d = await acmeDaisy();
  await d.ctx.app.inject({ method: "PUT", url: api.relay.relaySet.path, headers: d.withPin(), payload: { url: net_.url, acmeDirectory: acme.directory } });
  await until(() => status(d), (s) => s.cert.kind === "acme", 20_000, "acme");
  const certs = d.ctx.relay.current.certs!;
  const old = certs.certificate!;
  const oldId = ariCertId(old);
  assert.ok(oldId);
  const spki = certs.spki;
  acme.st.ari = { start: Date.now() - 3600_000, end: Date.now() - 60_000 };
  await certs.tick();
  assert.notEqual(certs.certificate, old);
  assert.equal(acme.st.issued.at(-1)!.replaces, oldId);
  assert.equal(certs.spki, spki, "the key is kept across renewals");
  // Not due (window in the future): nothing ordered.
  acme.st.ari = { start: Date.now() + 30 * 86400_000, end: Date.now() + 31 * 86400_000 };
  const orders = acme.st.orders.length;
  await certs.tick();
  assert.equal(acme.st.orders.length, orders);
  assert.ok((await status(d)).cert.renewAt > Date.now());
  // Due again, but the CA fails the challenge: the CA certificate stays, the problem is shown, a later try is set.
  acme.st.ari = { start: Date.now() - 3600_000, end: Date.now() - 60_000 };
  acme.st.failChallenge = true;
  const before = certs.certificate;
  await certs.tick();
  acme.st.failChallenge = false;
  const s = await status(d);
  assert.equal(certs.certificate, before);
  assert.equal(s.cert.kind, "acme");
  assert.match(s.cert.lastError, /域名验证失败|失败/);
  assert.ok(s.cert.renewAt - Date.now() > 50 * 60_000, "tries again in about an hour");
});

test("the self-signed fallback: a CA that refuses from the start — `daisy status` says only Daisies can use the relay address", async () => {
  const d = await acmeDaisy();
  acme.st.failChallenge = true;
  try {
    await d.ctx.app.inject({ method: "PUT", url: api.relay.relaySet.path, headers: d.withPin(), payload: { url: net_.url, acmeDirectory: acme.directory } });
    const s = await until(() => status(d), (x) => x.state === "connected" && !!x.cert.lastError, 20_000, "acme failed");
    assert.equal(s.cert.kind, "self-signed");
    assert.match(s.cert.note, /经中转只有 Daisy 之间能用/);
    // Between Daisies it works all the same: the claim names the self-signed certificate's key.
    const host = new URL(s.address).hostname;
    const c = await call(net_.port, host, { path: TLS_BINDING_PATH });
    assert.equal(c.authorized, false);
    const claim = await verifyBindingClaim(c.body, d.ctx.access.ai.self.publicJwk as any);
    assert.ok(claim.spki.includes(c.spki));
  } finally {
    acme.st.failChallenge = false;
  }
});

test("never a CA for a reserved name (the tests' relay.test), whatever the directory: no ACME attempt, said so", () => {
  assert.match(String(acmeUsable("relay.test", DEFAULT_ACME_DIRECTORY)), /保留的域名/);
  assert.equal(acmeUsable("relay.example.org", DEFAULT_ACME_DIRECTORY), null);
  // Review L-4: reserved whatever the directory (only the tests' stand-in switch lets it through).
  assert.match(String(acmeUsable("relay.test", "https://acme.test/directory")), /保留的域名/);
  assert.equal(acmeUsable("relay.test", "https://acme.test/directory", true), null);
  // Relay addresses: names only.
  for (const bad of ["https://127.0.0.1", "https://127.1", "https://[::1]", "relay", "https://1.2.3.4:443", "http://relay.example"])
    assert.ok("error" in parseRelayUrl(bad), bad);
  assert.deepEqual(parseRelayUrl("relay.example:8443"), { url: "https://relay.example:8443", domain: "relay.example", port: 8443 });
  assert.deepEqual(parseRelayUrl("https://Relay.Example/"), { url: "https://relay.example", domain: "relay.example", port: 443 });
});

// ── pure pieces ──────────────────────────────────────────────────────────

/** Capture a real ClientHello Node sends. */
async function captureHello(o: tls.ConnectionOptions): Promise<Buffer> {
  return new Promise((resolve) => {
    const srv = net.createServer((s) => {
      s.once("data", (d) => {
        resolve(Buffer.from(d));
        s.destroy();
        srv.close();
      });
    });
    srv.listen(0, "127.0.0.1", () => {
      const c = tls.connect({ host: "127.0.0.1", port: (srv.address() as any).port, rejectUnauthorized: false, ...o });
      c.on("error", () => {});
    });
  });
}

test("the ClientHello reader: SNI and ALPN from Node's real hellos, whole or in pieces; bad input is `bad`, never an exception", async () => {
  const h = await captureHello({ servername: "abc.relay.test", ALPNProtocols: ["acme-tls/1"] });
  const r = readClientHello(h, 16384);
  assert.deepEqual(r, { state: "ok", sni: "abc.relay.test", alpn: ["acme-tls/1"] });
  const h2 = await captureHello({ servername: "x.relay.test", ALPNProtocols: ["h2", "http/1.1"] });
  assert.deepEqual(readClientHello(h2, 16384), { state: "ok", sni: "x.relay.test", alpn: ["h2", "http/1.1"] });
  for (let i = 0; i < h.length; i += 7) assert.equal(readClientHello(h.subarray(0, i), 16384).state, "need");
  // Re-chunked into 100-byte records.
  const body = h.subarray(5);
  const recs: Buffer[] = [];
  for (let o = 0; o < body.length; o += 100) {
    const part = body.subarray(o, o + 100);
    recs.push(Buffer.from([22, 3, 1, part.length >> 8, part.length & 255]), part);
  }
  assert.deepEqual(readClientHello(Buffer.concat(recs), 16384), r);
  assert.equal(readClientHello(Buffer.from("GET / HTTP/1.1\r\n\r\n"), 16384).state, "bad");
  assert.equal(readClientHello(h, 64).state, "bad");
  for (let i = 0; i < 3000; i++) {
    const m = Buffer.from(h);
    for (let k = 0; k < 3; k++) m[5 + Math.floor(Math.random() * (m.length - 5))] = Math.floor(Math.random() * 256);
    const x = readClientHello(m, 16384);
    assert.ok(["ok", "bad", "need"].includes(x.state));
  }
});

test("x509: the self-signed certificate (ECDSA P-256, only the name), the CSR, the TLS-ALPN-01 certificate (critical acmeIdentifier = SHA-256 of the key authorization)", () => {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = selfSignedCert(privateKey, "abc.relay.test", 397);
  const x = new X509Certificate(pem);
  assert.equal(x.subjectAltName, "DNS:abc.relay.test");
  assert.ok(x.verify(x.publicKey));
  assert.ok(x.checkPrivateKey(privateKey));
  const ch = alpnChallengeCert("abc.relay.test", "token.thumb");
  const ext = alpnDigestOf(ch.cert)!;
  assert.equal(ext.critical, true);
  assert.deepEqual(ext.digest, createHash("sha256").update("token.thumb").digest());
  assert.equal(new X509Certificate(ch.cert).subjectAltName, "DNS:abc.relay.test");
  const csr = readCsr(csrDer(privateKey, "abc.relay.test"));
  assert.deepEqual(csr.dnsNames, ["abc.relay.test"]);
  // A CSR whose signature does not match is refused.
  const bad = csrDer(privateKey, "abc.relay.test");
  bad[bad.length - 3] ^= 1;
  assert.throws(() => readCsr(bad));
});

test("review L-1: a corrupt or loose ACME account key is a status error, never a crash — and stop() aborts an issuance in flight", async () => {
  const { mkdtempSync, writeFileSync, chmodSync, mkdirSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { RelayCerts } = await import("../packages/daisy/src/relay/certs.ts");
  const unhandled: unknown[] = [];
  const onRej = (e: unknown) => unhandled.push(e);
  process.on("unhandledRejection", onRej);
  try {
    for (const [content, mode] of [["x", 0o600], ["-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n", 0o644]] as const) {
      const dir = mkdtempSync(join(tmpdir(), "daisy-acme-key-"));
      mkdirSync(join(dir, "keys"), { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, "keys", "acme-account-key.pem"), content);
      chmodSync(join(dir, "keys", "acme-account-key.pem"), mode);
      const c = new RelayCerts(dir);
      c.start("abc.relay.test", { enabled: true, directory: "https://127.0.0.1:9/directory" }, null);
      await c.tick();
      const s = c.status();
      assert.equal(s.kind, "self-signed");
      assert.ok(s.lastError, "the problem is shown");
      assert.ok(s.renewAt && s.renewAt > Date.now(), "tried again later");
      c.stop();
      rmSync(dir, { recursive: true, force: true });
    }
    // An issuance in flight is aborted by stop() (the ACME server never answers here).
    net_ ??= await testRelay();
    const silent = await (await import("node:net")).createServer(() => {});
    await new Promise<void>((r) => silent.listen(0, "127.0.0.1", () => r()));
    const dir = mkdtempSync(join(tmpdir(), "daisy-acme-abort-"));
    const c = new RelayCerts(dir, { transport: { lookup: localLookup } });
    c.start("abc.relay.test", { enabled: true, directory: `https://acme.test:${(silent.address() as any).port}/directory` }, null);
    const t0 = Date.now();
    const p = c.tick();
    setTimeout(() => c.stop(), 200);
    await p;
    assert.ok(Date.now() - t0 < 5000, `aborted in ${Date.now() - t0} ms`);
    silent.close();
    rmSync(dir, { recursive: true, force: true });
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onRej);
  }
});

test("review L-4: reserved names never go to a CA, whatever the directory (only the tests' stand-in may, by an explicit tests-only switch)", () => {
  assert.match(String(acmeUsable("relay.test", "https://acme.example.org/directory")), /保留的域名/);
  assert.match(String(acmeUsable("relay.localhost", DEFAULT_ACME_DIRECTORY)), /保留的域名/);
  assert.equal(acmeUsable("relay.test", "https://acme.test/directory", true), null);
  assert.equal(acmeUsable("relay.example.org", "https://acme.example.org/directory"), null);
});
