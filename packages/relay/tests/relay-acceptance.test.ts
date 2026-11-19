/**
 * P5-01 acceptance (plan §8 N-2, N-3, N-4; ADR-100 "malicious relay"),
 * automated, on localhost with the fake domain `relay.test` and a test CA.
 *
 * - N-2: everything that passes through the relay is recorded — every byte
 *   on the relay's public port (a TCP tap in front of it), every byte the
 *   relay hands the Daisy (the data frames) and every log line. Real TLS
 *   runs end to end; the only readable thing is the SNI.
 * - N-3: the target is not online → the caller is refused at the handshake
 *   within the plan's 5 s (9.1), nothing of the request reaches or stays
 *   on the relay, and nothing is delivered when the target comes online.
 * - N-4: the relay restarts → the Daisy is back within the plan's 30 s
 *   (9.1), with a growing delay between tries.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { X509Certificate } from "node:crypto";
import { fixture, until, sleep, DOMAIN } from "./helpers/fixture.ts";
import { call, handshake, newIdentity, tap, localLookup, type Tapped } from "./helpers/daisy-side.ts";
import { parseClientHello } from "../src/sni.ts";
import { ALERT } from "../src/protocol.ts";

const REQUEST_SECRET = "REQ-plaintext-7f3a9c";
const TOKEN_SECRET = "TOKEN-bearer-c0ffee42";
const PATH_SECRET = "/a2a/path-secret-91b2";
const RESPONSE_SECRET = "RESP-plaintext-5e6d1b";
const SECRETS = [REQUEST_SECRET, TOKEN_SECRET, PATH_SECRET, RESPONSE_SECRET];

/** Concatenate one tapped connection's bytes in one direction. */
const bytesOf = (log: Tapped[], conn: number, dir: "up" | "down") =>
  Buffer.concat(log.filter((t) => t.conn === conn && t.dir === dir).map((t) => t.bytes));

/** The TLS records of a byte stream: [type, length] each; throws if the framing does not add up. */
function records(b: Buffer): { type: number; len: number }[] {
  const out: { type: number; len: number }[] = [];
  let o = 0;
  while (o < b.length) {
    assert.ok(o + 5 <= b.length, "a cut-off record header");
    const type = b[o]!;
    assert.ok([20, 21, 22, 23].includes(type), `record type ${type} is not TLS`);
    assert.equal(b[o + 1], 3, "record version major");
    const len = b.readUInt16BE(o + 3);
    assert.ok(len > 0 && len <= 16384 + 256, `record length ${len}`);
    out.push({ type, len });
    o += 5 + len;
  }
  assert.equal(o, b.length, "the stream is exactly a sequence of TLS records");
  return out;
}

function assertNoSecret(where: string, b: Buffer | string) {
  const s = typeof b === "string" ? b : b.toString("latin1");
  for (const x of SECRETS) assert.ok(!s.includes(x), `${where} contains plaintext ${x}`);
}

test("N-2: the relay sees only the SNI and TLS ciphertext — capture of every byte through it", async (t) => {
  const f = await fixture();
  const wire = await tap(f.relay.port);
  t.after(async () => {
    await f.close();
    await wire.close();
  });
  const d = f.daisy({
    port: wire.port,
    handler: (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        assert.equal(req.headers.authorization, `Bearer ${TOKEN_SECRET}`);
        res.end(`${RESPONSE_SECRET} ${req.url} ${body.length} ${body.slice(0, REQUEST_SECRET.length)}`);
      });
    },
  });
  await d.start();

  // Several real HTTPS calls end to end through the relay (one with a big body: many records).
  const big = REQUEST_SECRET + "x".repeat(200_000);
  for (const body of [REQUEST_SECRET, big, REQUEST_SECRET + " again"]) {
    const r = await call(wire.port, d.host, f.ca.cert, {
      method: "POST",
      path: PATH_SECRET,
      body,
      headers: { authorization: `Bearer ${TOKEN_SECRET}` },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body, `${RESPONSE_SECRET} ${PATH_SECRET} ${body.length} ${REQUEST_SECRET}`);
    // TLS ended at the Daisy: the caller saw the Daisy's certificate, not the relay's.
    assert.equal(r.peerSpki, d.leaf.spki);
    assert.notEqual(r.peerSpki, f.own.spki);
  }
  await until(() => f.relay.state().streams === 0, 5000, "streams closed");

  // 1. Caller-side connections on the relay's public port.
  const conns = [...new Set(wire.log.map((x) => x.conn))];
  const callerConns = conns.filter((c) => {
    const h = parseClientHello(bytesOf(wire.log, c, "up"), 16384);
    return h.state === "ok" && h.sni === d.host;
  });
  assert.equal(callerConns.length, 3, "three caller connections, recognised by their SNI");
  const daisyDer = new X509Certificate(d.leaf.cert).raw;
  for (const c of callerConns) {
    const up = bytesOf(wire.log, c, "up");
    const down = bytesOf(wire.log, c, "down");
    // Exactly TLS records both ways — the relay injected and removed nothing.
    const ru = records(up);
    const rd = records(down);
    assert.equal(ru[0]!.type, 22, "starts with the ClientHello");
    // TLS 1.3: after the hellos everything is application_data (encrypted),
    // including the Daisy's certificate.
    assert.ok(
      ru.slice(1).every((r) => r.type === 23 || r.type === 20),
      "caller → Daisy: only ciphertext after the ClientHello",
    );
    assert.ok(
      rd.slice(1).every((r) => r.type === 23 || r.type === 20),
      "Daisy → caller: only ciphertext after the ServerHello",
    );
    assert.ok(!down.includes(daisyDer), "the Daisy's certificate is not visible either (TLS 1.3)");
    assertNoSecret(`caller connection ${c}`, Buffer.concat([up, down]));
    // The SNI is the one readable thing (ADR-100 A1).
    assert.ok(up.toString("latin1").includes(d.host));
  }

  // 2. What the relay handed the Daisy is byte for byte what the caller sent,
  //    and the reverse — nothing added, nothing changed. (A record sent after
  //    the other side closed, like the caller's close_notify, may not arrive.)
  const ns = [...new Set(d.frames.map((x) => x.n))];
  assert.equal(ns.length, 3);
  const ups = callerConns.map((c) => bytesOf(wire.log, c, "up"));
  const downs = callerConns.map((c) => bytesOf(wire.log, c, "down"));
  const isPrefix = (whole: Buffer, part: Buffer) => part.length > 0 && whole.subarray(0, part.length).equals(part);
  const used = new Set<number>();
  for (const n of ns) {
    const toDaisy = Buffer.concat(d.frames.filter((x) => x.n === n && x.dir === "toDaisy").map((x) => x.bytes));
    const fromDaisy = Buffer.concat(d.frames.filter((x) => x.n === n && x.dir === "fromDaisy").map((x) => x.bytes));
    const i = ups.findIndex((u, k) => !used.has(k) && isPrefix(u, toDaisy) && isPrefix(fromDaisy, downs[k]!));
    assert.ok(i >= 0, `stream ${n}: the Daisy got exactly one caller's bytes, and the caller exactly the Daisy's`);
    used.add(i);
    records(ups[i]!.subarray(toDaisy.length)); // what did not arrive is whole records
    assert.ok(ups[i]!.length - toDaisy.length <= 64, "at most a closing alert did not arrive");
    assert.ok(fromDaisy.length - downs[i]!.length <= 64, "at most a closing alert did not arrive");
    assertNoSecret(`stream ${n} as handed to the Daisy`, Buffer.concat([toDaisy, fromDaisy]));
  }

  // 3. Every other byte on the public port (the Daisy's own control / data
  //    connections to relay.test) carries no plaintext either.
  for (const c of conns)
    assertNoSecret(`connection ${c}`, Buffer.concat([bytesOf(wire.log, c, "up"), bytesOf(wire.log, c, "down")]));

  // 4. The logs: no plaintext, no claim, no nonce, no field outside the allow-list.
  const logText = f.logs.join("\n");
  assertNoSecret("logs", logText);
  for (const o of d.opens) assert.ok(!logText.includes(o.claim), "a claim in the logs");
  for (const m of d.controlLog)
    if (m.t === "challenge") assert.ok(!logText.includes(m.nonce as string), "a nonce in the logs");
  assert.equal(f.logger.dropped, 0);
  for (const line of f.logs) {
    const o = JSON.parse(line);
    for (const v of Object.values(o)) if (typeof v === "string") assert.ok(v.length <= 120);
  }

  // 5. Nothing held afterwards.
  const st = f.relay.state();
  assert.equal(st.pending, 0);
  assert.equal(st.heldBytes, 0);
});

test("N-3: target offline → refused at the handshake within 5 s; nothing reaches or stays on the relay", async (t) => {
  const f = await fixture();
  const wire = await tap(f.relay.port);
  t.after(async () => {
    await f.close();
    await wire.close();
  });
  const offline = newIdentity();
  const host = `${offline.sub}.${DOMAIN}`;

  // The presence query (D1): not online.
  const presence = await presenceOf(wire.port, f.ca.cert, offline.sub);
  assert.deepEqual(presence, { v: 1, subdomain: offline.sub, online: false });

  // A real HTTPS call with a body and a token: refused at the handshake.
  const t0 = Date.now();
  const err = await call(wire.port, host, f.ca.cert, {
    method: "POST",
    path: PATH_SECRET,
    body: REQUEST_SECRET,
    headers: { authorization: `Bearer ${TOKEN_SECRET}` },
  }).then(
    () => null,
    (e: NodeJS.ErrnoException) => e,
  );
  const ms = Date.now() - t0;
  assert.ok(err, "the call must fail");
  assert.match(err.message, /unrecognized name|alert number 112/, "TLS alert unrecognized_name (D1)");
  assert.ok(ms < 5000, `refused in ${ms} ms (plan 9.1: within 5 s)`);

  // What crossed the wire from the caller: the ClientHello and nothing else —
  // the request and the token were never sent, so the relay cannot have them.
  const conns = [...new Set(wire.log.map((x) => x.conn))];
  const callerConn = conns.find((c) => {
    const h = parseClientHello(bytesOf(wire.log, c, "up"), 16384);
    return h.state === "ok" && h.sni === host;
  })!;
  assert.ok(callerConn);
  const up = bytesOf(wire.log, callerConn, "up");
  const down = bytesOf(wire.log, callerConn, "down");
  assert.ok(
    records(up).every((r) => r.type === 22),
    "only handshake records from the caller",
  );
  assert.deepEqual(
    [...down],
    [0x15, 0x03, 0x03, 0x00, 0x02, 0x02, ALERT.unrecognizedName],
    "exactly one fatal alert back",
  );
  assertNoSecret("caller bytes", up);
  assertNoSecret("logs", f.logs.join("\n"));

  // Nothing kept: no record of the name, no pending stream, no held bytes.
  await until(() => f.relay.state().publicConnections <= 0 + 1, 3000, "refused socket closed");
  const st = f.relay.state();
  assert.equal(st.known, 0, "the relay keeps no record of the offline name");
  assert.equal(st.pending, 0);
  assert.equal(st.heldBytes, 0);

  // The target comes online: nothing is delivered to it (no store-and-forward).
  const d = f.daisy({ identity: offline, port: wire.port });
  await d.start();
  await sleep(300);
  assert.equal(d.opens.length, 0, "no stored request delivered");
  assert.deepEqual(await presenceOf(wire.port, f.ca.cert, offline.sub), { v: 1, subdomain: offline.sub, online: true });
  // …and a call now works.
  assert.equal((await call(wire.port, host, f.ca.cert)).status, 200);

  // Goes offline again: refused again, at once.
  await d.stop();
  await until(() => f.relay.state().online.length === 0, 3000, "offline");
  const h = await handshake(wire.port, host, f.ca.cert);
  assert.equal(h.ok, false);
  assert.equal(h.code, "ERR_SSL_TLSV1_UNRECOGNIZED_NAME");
});

test("N-3: online but not answering → refused within the claim timeout; a Daisy that drops off refuses its waiting callers at once", async (t) => {
  const f = await fixture({ claimTimeoutMs: 800 });
  t.after(() => f.close());
  // A Daisy that keeps its control connection but never claims.
  const silent = f.daisy({ silent: true });
  await silent.start();
  const t0 = Date.now();
  const h = await handshake(f.relay.port, silent.host, f.ca.cert);
  const ms = Date.now() - t0;
  assert.equal(h.ok, false);
  assert.equal(h.code, "ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR");
  assert.ok(ms >= 700 && ms < 5000, `refused after the claim timeout (${ms} ms)`);
  assert.equal(silent.opens.length, 1);
  assert.equal(f.relay.state().pending, 0);
  assert.equal(f.relay.state().heldBytes, 0);

  // A second silent Daisy drops its control connection while a caller waits: refused at once.
  const f2 = await fixture({ claimTimeoutMs: 4000 });
  t.after(() => f2.close());
  const d2 = f2.daisy({ silent: true, backoff: { baseMs: 60_000, maxMs: 60_000 } });
  await d2.start();
  const pending = handshake(f2.relay.port, d2.host, f2.ca.cert);
  await until(() => d2.opens.length === 1, 3000, "open sent");
  const t1 = Date.now();
  d2.dropControl();
  const r = await pending;
  assert.equal(r.code, "ERR_SSL_TLSV1_UNRECOGNIZED_NAME");
  assert.ok(Date.now() - t1 < 1500, "refused as soon as the Daisy went offline");
  assert.equal(f2.relay.state().known, 0);
});

test("N-4: the relay restarts → the Daisy reconnects within the bound, with growing delays", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const d = f.daisy({ backoff: { baseMs: 100, maxMs: 2000 } });
  await d.start();
  const port = f.relay.port;
  assert.equal((await call(port, d.host, f.ca.cert)).status, 200);

  // Restart: the old relay tells Daisys 1012 and goes away; the new one comes up 1.5 s later.
  const closed = new Promise<number>((r) => d.once("closed", r));
  await f.relay.close();
  assert.equal(await closed, 1012, "the Daisy is told the relay is restarting");
  const down = Date.now();
  await sleep(1500);
  await f.start(port);
  const back = d.nextWelcome();
  await back;
  const ms = Date.now() - down;
  assert.ok(ms < 30_000, `back after ${ms} ms (plan 9.1: within 30 s)`);
  assert.ok(ms < 6000, `back after ${ms} ms (the test's own bound with this backoff)`);
  // It tried while the relay was down (connection refused), more than once, with growing delays.
  assert.ok(d.closeCodes.filter((c) => c === 1006).length >= 2, `retried: ${d.closeCodes.join(",")}`);
  // base·2^k·(0.5–1) never shrinks from one try to the next.
  const tries = d.attempts.filter((a) => a >= down - 200);
  const gaps = tries.slice(1).map((a, i) => a - tries[i]!);
  for (let i = 1; i < gaps.length; i++) assert.ok(gaps[i]! >= gaps[i - 1]! - 30, `delays grow: ${gaps.join(", ")}`);
  // Same subdomain, and calls work again through the new relay.
  assert.deepEqual(f.relay.state().online, [d.identity.sub]);
  assert.equal((await call(port, d.host, f.ca.cert)).status, 200);
});

test("ADR-100 malicious relay: a relay that terminates TLS with a CA cert for the subdomain fools WebPKI, not the identity-signed key pin", async (t) => {
  // The honest relay delivered the Daisy's own key (N-2 above). A relay
  // operator controls DNS and port 443, so it can get a CA certificate for
  // `<sub>.relay.test` and sit in the middle. Simulated here: a MITM with such
  // a certificate in front of the honest relay.
  const f = await fixture();
  t.after(() => f.close());
  const d = f.daisy();
  await d.start();
  const forged = f.ca.issue([d.host]);
  let seen = "";
  const mitm = tls.createServer({ cert: forged.cert, key: forged.key }, (inner) => {
    const out = tls.connect({ host: "127.0.0.1", port: f.relay.port, servername: d.host, ca: f.ca.cert });
    inner.on("data", (b) => {
      seen += b.toString("latin1");
      out.write(b);
    });
    out.on("data", (b) => {
      seen += b.toString("latin1");
      inner.write(b);
    });
    inner.on("error", () => out.destroy());
    out.on("error", () => inner.destroy());
    inner.on("end", () => out.end());
    out.on("end", () => inner.end());
  });
  await new Promise<void>((r) => mitm.listen(0, "127.0.0.1", () => r()));
  t.after(() => mitm.close());
  const mport = (mitm.address() as net.AddressInfo).port;

  const r = await call(mport, d.host, f.ca.cert, {
    method: "POST",
    path: PATH_SECRET,
    body: REQUEST_SECRET,
    headers: { authorization: `Bearer ${TOKEN_SECRET}` },
  });
  // A plain WebPKI client is fooled — the limit ADR-100 writes down and D-41 ② accepts:
  assert.equal(r.status, 200);
  assert.ok(seen.includes(TOKEN_SECRET) && seen.includes(REQUEST_SECRET), "the malicious relay read the request");
  // …but the key it presented is not the Daisy's. A Daisy caller checks the
  // TLS binding statement (the SPKI signed by the callee's identity key, which
  // the relay does not hold) before sending any token, so it would stop here
  // (P5-02 / a2a-usage: verify before the token).
  assert.notEqual(r.peerSpki, d.leaf.spki);
  // The honest relay, by contrast, presents the Daisy's own key.
  assert.equal((await call(f.relay.port, d.host, f.ca.cert)).peerSpki, d.leaf.spki);
});

/** GET https://relay.test/v1/presence/<sub> through the relay's public port. */
function presenceOf(port: number, ca: string, sub: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    https
      .get(
        { host: DOMAIN, port, path: `/v1/presence/${sub}`, ca, agent: false, lookup: localLookup as never },
        (res) => {
          let s = "";
          res.on("data", (c) => (s += c));
          res.on("end", () => resolve(JSON.parse(s)));
        },
      )
      .on("error", reject);
  });
}
