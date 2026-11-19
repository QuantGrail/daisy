/**
 * P5-01 security review round 1 (ADR-143 §9): each finding gets a test that
 * fails on the reviewed code and passes on the fix — refused first.
 *
 * Two local source addresses stand in for two sources: 127.0.0.1 and ::1
 * (the relay listens on "::", dual stack).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import tls from "node:tls";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { fixture, until, sleep, DOMAIN, type Fixture } from "./helpers/fixture.ts";
import { call, dataUpgrade, handshake, lookupTo, newIdentity, signProof } from "./helpers/daisy-side.ts";
import { CLAIM_HEADER, CLOSE, proofPayload } from "../src/protocol.ts";
import { DEFAULT_LIMITS } from "../src/config.ts";
import { Sources, sourceKeys } from "../src/limits.ts";
import { main } from "../src/main.ts";
import { TestCA } from "./helpers/pki.ts";

/** Is ::1 usable here (some CI containers have no IPv6 loopback)? */
const v6 = await new Promise<boolean>((resolve) => {
  const s = net.createServer();
  s.once("error", () => resolve(false));
  s.listen(0, "::1", () => s.close(() => resolve(true)));
});
const dual = { skip: v6 ? false : "no IPv6 loopback here" };

/** A bare control upgrade from `from`: "challenge" when it got one, else the HTTP status. */
function controlFrom(f: Fixture, from: "127.0.0.1" | "::1", headers: Record<string, string> = {}) {
  return new Promise<{ status: number | "challenge"; ws?: WebSocket }>((resolve) => {
    const ws = new WebSocket(`wss://${DOMAIN}:${f.relay.port}/v1/control`, {
      ca: f.ca.cert,
      lookup: from === "::1" ? lookupTo("::1", 6) : lookupTo("127.0.0.1", 4),
      headers,
      perMessageDeflate: false,
    } as never);
    ws.on("error", () => resolve({ status: 0 }));
    ws.on("unexpected-response", (_q, res) => {
      resolve({ status: res.statusCode ?? 0 });
      res.resume();
    });
    ws.on("message", () => resolve({ status: "challenge", ws }));
  });
}

test(
  "M1: unauthenticated control slots are shared per source — one address cannot hold them all; hello timeout is short",
  dual,
  async (t) => {
    assert.ok(DEFAULT_LIMITS.helloTimeoutMs <= 3000);
    const f = await fixture({ maxUnauthControlsPerIp: 3, maxUnauthenticatedControls: 100 }, "debug", { host: "::" });
    t.after(() => f.close());
    const held = [];
    for (let i = 0; i < 3; i++) held.push(await controlFrom(f, "127.0.0.1"));
    assert.ok(held.every((h) => h.status === "challenge"));
    assert.equal((await controlFrom(f, "127.0.0.1")).status, 429, "the fourth from the same source");
    // Another source still registers a Daisy.
    const d = f.daisy({ from: "::1" });
    await d.start();
    assert.equal(f.relay.state().online.length, 1);
    for (const h of held) h.ws!.terminate();
    await until(() => f.relay.state().unauthenticatedControls === 0, 3000, "slots released");
    assert.equal((await controlFrom(f, "127.0.0.1")).status, "challenge", "released slots are usable again");
  },
);

test(
  "M1: registered Daisys are capped per source; a key already online keeps its slot; operator allow-list",
  dual,
  async (t) => {
    const f = await fixture({ maxDaisysPerIp: 2 }, "debug", { host: "::" });
    t.after(() => f.close());
    const a = f.daisy();
    const b = f.daisy();
    await a.start();
    await b.start();
    const c = f.daisy({ backoff: { baseMs: 60_000, maxMs: 60_000 } });
    const closed = new Promise<number>((r) => c.once("closed", r));
    void c.start();
    assert.equal(await closed, CLOSE.full, "a third fresh key from the same source");
    // The same key reconnecting is not a new Daisy.
    a.dropControl();
    await a.nextWelcome();
    // Another source is not affected.
    const other = f.daisy({ from: "::1" });
    await other.start();
    assert.equal(f.relay.state().online.length, 3);
    // A Daisy that leaves gives its slot back.
    await b.stop();
    await until(() => f.relay.state().online.length === 2, 3000, "b offline");
    const d = f.daisy();
    await d.start();

    const allowed = newIdentity();
    const g = await fixture({}, "debug", { allowIdentities: [allowed.id] });
    t.after(() => g.close());
    const ok = g.daisy({ identity: allowed });
    await ok.start();
    const stranger = g.daisy({ backoff: { baseMs: 60_000, maxMs: 60_000 } });
    const sc = new Promise<number>((r) => stranger.once("closed", r));
    void stranger.start();
    assert.equal(await sc, CLOSE.notAllowed);
    assert.deepEqual(g.relay.state().online, [allowed.sub]);
  },
);

test("M1: upgrades carrying an Origin header are refused; the claim is checked before the upgrade (no unclaimed pool)", async (t) => {
  const f = await fixture({ claimTimeoutMs: 4000 });
  t.after(() => f.close());
  assert.equal((await controlFrom(f, "127.0.0.1", { origin: "https://evil.example" })).status, 403);
  const d = f.daisy({ silent: true });
  await d.start();
  const caller = handshake(f.relay.port, d.host, f.ca.cert);
  await until(() => d.opens.length === 1, 2000, "open");
  const claim = d.opens[0]!.claim;
  assert.equal(
    (await dataUpgrade(f.relay.port, f.ca.cert, { [CLAIM_HEADER]: claim, origin: "https://x" })).status,
    403,
  );
  // Many data upgrades without a valid claim hold nothing: each is refused before the upgrade.
  const bad = await Promise.all(
    Array.from({ length: 20 }, () => dataUpgrade(f.relay.port, f.ca.cert, { [CLAIM_HEADER]: "A".repeat(43) })),
  );
  assert.ok(
    bad.every((b) => b.status === 404 || b.status === 429),
    bad.map((b) => b.status).join(","),
  );
  assert.ok(!("unclaimedData" in f.relay.state()));
  // The real claim still works (Origin refusal did not consume it), once.
  const up = await dataUpgrade(f.relay.port, f.ca.cert, { [CLAIM_HEADER]: claim });
  assert.equal(up.status, 101);
  await until(() => up.got.length > 0, 2000, "ClientHello delivered");
  assert.equal(up.got[0]![0], 22, "the first frame is the caller's ClientHello");
  up.ws!.terminate();
  await caller;
});

test("M2: a stream's buffering is bounded even when the caller never reads and the Daisy floods", async (t) => {
  assert.ok(DEFAULT_LIMITS.maxDataFrameBytes <= 65_536);
  assert.ok(DEFAULT_LIMITS.streamWindowBytes <= 262_144);
  const W = 128 * 1024;
  const f = await fixture({ streamWindowBytes: W });
  t.after(() => f.close());
  const d = f.daisy({ silent: true });
  await d.start();
  // A caller that sends its ClientHello and then never reads.
  const hello = await captureHello(d.host);
  const caller = net.connect(f.relay.port, "127.0.0.1");
  caller.on("error", () => {});
  await new Promise((r) => caller.once("connect", r));
  caller.write(hello);
  caller.pause();
  await until(() => d.opens.length === 1, 2000, "open");
  const up = await dataUpgrade(f.relay.port, f.ca.cert, { [CLAIM_HEADER]: d.opens[0]!.claim });
  const ws = up.ws!;
  const frame = Buffer.alloc(64 * 1024, 0x17);
  let sent = 0;
  const pump = setInterval(() => {
    while (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 4 << 20) {
      ws.send(frame);
      sent += frame.length;
    }
  }, 20);
  t.after(() => clearInterval(pump));
  await sleep(1500);
  const st = f.relay.state();
  // The Daisy filled its own send buffer: the relay stopped reading from it.
  assert.ok(sent >= 4 << 20, `the Daisy offered ${sent} bytes`);
  // Window per direction + one socket buffer + one frame in flight; far below what was offered.
  assert.ok(st.bufferedBytes <= 4 * W + 2 * 65_536, `relay holds ${st.bufferedBytes} bytes for one stream`);
  clearInterval(pump);
  caller.destroy();
  ws.terminate();
});

test("M2: a relay-wide byte budget — over it, new streams are refused", async (t) => {
  const f = await fixture({ maxBufferedBytes: 64 * 1024, streamWindowBytes: 256 * 1024, claimTimeoutMs: 4000 });
  t.after(() => f.close());
  const d = f.daisy({ silent: true });
  await d.start();
  const hello = await captureHello(d.host);
  const caller = net.connect(f.relay.port, "127.0.0.1");
  caller.on("error", () => {});
  await new Promise((r) => caller.once("connect", r));
  caller.write(hello);
  caller.pause();
  await until(() => d.opens.length === 1, 2000, "open");
  const up = await dataUpgrade(f.relay.port, f.ca.cert, { [CLAIM_HEADER]: d.opens[0]!.claim });
  const ws = up.ws!;
  // The Daisy floods until the relay's own queues pass the budget. How much
  // that takes depends on the system's socket buffers (Linux loopback takes
  // megabytes before the caller's socket backs up), so keep offering.
  const frame = Buffer.alloc(64 * 1024, 0x17);
  const pump = setInterval(() => {
    while (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 1 << 20) ws.send(frame);
  }, 20);
  t.after(() => clearInterval(pump));
  await until(() => f.relay.state().budgetBytes > 64 * 1024, 10_000, "budget used");
  const h = await handshake(f.relay.port, d.host, f.ca.cert);
  assert.match(h.message ?? "", /internal error/, "new stream refused while over budget");
  assert.ok((f.relay.state().refusals.buffer_budget ?? 0) >= 1);
  clearInterval(pump);
  caller.destroy();
  ws.terminate();
  await until(() => f.relay.state().streams === 0, 3000, "torn down");
});

test("M2: a closing stream still counts against the Daisy's streams until it is torn down", async (t) => {
  const f = await fixture({
    maxStreamsPerDaisy: 1,
    maxPendingPerDaisy: 1,
    streamCloseGraceMs: 800,
    claimTimeoutMs: 4000,
  });
  t.after(() => f.close());
  const d = f.daisy({ silent: true });
  await d.start();
  const hello = await captureHello(d.host);
  const caller = net.connect(f.relay.port, "127.0.0.1");
  caller.on("error", () => {});
  await new Promise((r) => caller.once("connect", r));
  caller.write(hello);
  caller.pause(); // never reads: what the Daisy sends stays queued
  await until(() => d.opens.length === 1, 2000, "open");
  const up = await dataUpgrade(f.relay.port, f.ca.cert, { [CLAIM_HEADER]: d.opens[0]!.claim });
  const ws = up.ws!;
  for (let i = 0; i < 3; i++) ws.send(Buffer.alloc(64 * 1024, 0x17));
  await sleep(200);
  ws.close(); // the Daisy is done; the caller has not taken its bytes
  await sleep(100);
  assert.equal(f.relay.state().streams, 1, "still counted while closing");
  const h = await handshake(f.relay.port, d.host, f.ca.cert);
  assert.match(h.message ?? "", /internal error/, "no new stream past the cap meanwhile");
  await until(() => f.relay.state().streams === 0, 3000, "torn down after the grace");
  caller.destroy();
});

test(
  "M3: Daisys behind one address do not starve each other — claimed data connections count for their Daisy",
  dual,
  async (t) => {
    // A and B share 127.0.0.1. Callers (from ::1) hold many connections to A.
    const f = await fixture(
      { maxConnectionsPerIp: 8, ownRequestsPerIpBurst: 6, ownRequestsPerIpPerSec: 1, newConnectionsPerIpBurst: 100 },
      "debug",
      { host: "::" },
    );
    t.after(() => f.close());
    const A = f.daisy();
    const B = f.daisy();
    await A.start();
    await B.start();
    const held: tls.TLSSocket[] = [];
    for (let i = 0; i < 6; i++) {
      const s = tls.connect({ host: "::1", port: f.relay.port, servername: A.host, ca: f.ca.cert });
      s.on("error", () => {});
      await new Promise((r) => s.once("secureConnect", r));
      held.push(s);
    }
    t.after(() => held.forEach((s) => s.destroy()));
    assert.equal(f.relay.state().streams, 6);
    // Before the fix: 127.0.0.1 held 2 controls + 6 data connections = its cap of 8,
    // and the data upgrades had spent its request burst.
    // B's callers (another source) still get through: B's data connections from
    // the shared address are not refused by that address's connection or request caps.
    for (let i = 0; i < 4; i++) {
      const r = await call(f.relay.port, B.host, f.ca.cert, { from: "::1" });
      assert.equal(r.status, 200, `call ${i} to B`);
      await until(() => f.relay.state().streams === 6, 3000, "the call's stream torn down");
    }
  },
);

test(
  "M3: …nor does the shared address's new-connection rate (a claimed data connection gives its token back)",
  dual,
  async (t) => {
    const f = await fixture({ newConnectionsPerIpPerSec: 1, newConnectionsPerIpBurst: 8 }, "debug", { host: "::" });
    t.after(() => f.close());
    const A = f.daisy();
    const B = f.daisy();
    await A.start();
    await B.start(); // 127.0.0.1: 2 tokens spent
    const held: tls.TLSSocket[] = [];
    for (let i = 0; i < 3; i++) {
      const s = tls.connect({ host: "::1", port: f.relay.port, servername: A.host, ca: f.ca.cert });
      s.on("error", () => {});
      await new Promise((r) => s.once("secureConnect", r));
      held.push(s);
    }
    t.after(() => held.forEach((s) => s.destroy()));
    // Without the refund 127.0.0.1 would need 2 + 3 + 5 = 10 tokens out of 8 (+ ~1 refilled).
    for (let i = 0; i < 5; i++) {
      const r = await call(f.relay.port, B.host, f.ca.cert, { from: "::1" });
      assert.equal(r.status, 200, `call ${i} to B`);
    }
  },
);

test("L1: --check refuses any certificate naming more than exactly the relay's domain", async () => {
  const ca = new TestCA();
  const dir = mkdtempSync(join(tmpdir(), "relay-l1-"));
  try {
    const run = async (names: string[]) => {
      const leaf = ca.issue(names);
      writeFileSync(join(dir, "c.pem"), leaf.cert);
      writeFileSync(join(dir, "k.pem"), leaf.key);
      const out = process.stdout.write;
      const err = process.stderr.write;
      process.stdout.write = (() => true) as never;
      process.stderr.write = (() => true) as never;
      try {
        return await main(["--check"], {
          DAISY_RELAY_DOMAIN: "relay.test",
          DAISY_RELAY_TLS_CERT: join(dir, "c.pem"),
          DAISY_RELAY_TLS_KEY: join(dir, "k.pem"),
        });
      } finally {
        process.stdout.write = out;
        process.stderr.write = err;
      }
    };
    assert.equal(await run(["relay.test"]), 0);
    for (const extra of ["*.relay.test", "z*.relay.test", "zbcdefghijklmnopqrstuvwxyz234567.relay.test", "other.test"])
      assert.equal(await run(["relay.test", extra]), 2, extra);
    assert.equal(await run(["other.test"]), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("L2: per-source counting at /64, /56 and /48; forgetting an entry never resets a bucket", () => {
  assert.deepEqual(
    sourceKeys("2001:db8:aa:bb11:1::1").map((k) => k.key),
    ["2001:db8:aa:bb11::/64", "2001:db8:aa:bb00::/56", "2001:db8:aa::/48"],
  );
  assert.deepEqual(
    sourceKeys("10.0.0.1").map((k) => k.key),
    ["10.0.0.1"],
  );
  const s = new Sources(1000, [1, 4, 16], { newConn: [1, 2], own: [1, 2] });
  // One /64 gets 2; a whole /56 gets 8 across its /64s; a /48 gets 32.
  const take = (ip: string) => s.admit(ip, "unauth", 2);
  assert.ok(take("2001:db8:aa:bb01::1"));
  assert.ok(take("2001:db8:aa:bb01::2"));
  assert.equal(take("2001:db8:aa:bb01::3"), null, "the /64 is full");
  let n = 2;
  for (let i = 2; i < 64; i++) if (take(`2001:db8:aa:bb${i.toString(16).padStart(2, "0")}::1`)) n++;
  assert.equal(n, 8, "the /56 caps all its /64s together");
  let m = 0;
  for (let i = 0; i < 256; i++) if (take(`2001:db8:aa:${i.toString(16)}00::1`)) m++;
  assert.ok(n + m <= 32, `the /48 caps everything under it (${n + m})`);
  // A spent bucket is not forgotten by sweeping or by a full table.
  const small = new Sources(2, [1, 4, 16], { newConn: [0.001, 1], own: [1, 1] });
  assert.ok(small.take("10.0.0.1", "newConn"));
  small.sweep();
  assert.ok(!small.take("10.0.0.1", "newConn"), "still spent after a sweep");
  assert.ok(small.take("10.0.0.2", "newConn"));
  assert.equal(
    small.take("10.0.0.3", "newConn"),
    false,
    "a full table refuses a new source rather than evicting a live one",
  );
  assert.ok(!small.take("10.0.0.1", "newConn"), "and the first is still spent");
});

test("L3: unauthenticated peers cannot write info lines at will — debug per event, totals at info", async (t) => {
  const f = await fixture({ refusalLogIntervalMs: 300 }, "info");
  t.after(() => f.close());
  for (let i = 0; i < 20; i++) {
    const label = `${"a".repeat(31)}${"bcdefghijklmnopqrstu"[i]}`;
    await handshake(f.relay.port, `${label}.${DOMAIN}`, f.ca.cert);
  }
  for (let i = 0; i < 5; i++) {
    const r = await controlFrom(f, "127.0.0.1");
    r.ws!.send(JSON.stringify({ t: "hello", v: 1, proof: "x.y.z" }));
  }
  await sleep(500);
  const lines = f.logs.map((l) => JSON.parse(l));
  assert.ok(!lines.some((o) => o.lvl === "info" && /refused/.test(o.ev)), "no per-event info line");
  assert.ok(
    !f.logs.some((l) => l.includes("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab")),
    "attacker-chosen labels never reach info",
  );
  const totals = lines.filter((o) => o.ev === "relay.refusals");
  assert.ok(
    totals.some((o) => o.reason === "offline" && o.count === 20),
    JSON.stringify(totals),
  );
  assert.ok(
    totals.some((o) => o.reason === "header" && o.count === 5),
    JSON.stringify(totals),
  );
});

// Node's own handshakeTimeout is already absolute; the relay adds its own
// absolute deadline from the hand-off as a second guard. This pins the behaviour.
test("probe B: a TLS handshake to the relay's own name trickled byte by byte ends at an absolute deadline", async (t) => {
  const f = await fixture({ ownTlsHandshakeTimeoutMs: 800 });
  t.after(() => f.close());
  const hello = await captureHello(DOMAIN);
  const s = net.connect(f.relay.port, "127.0.0.1");
  s.on("error", () => {});
  s.on("data", () => {});
  await new Promise((r) => s.once("connect", r));
  const t0 = Date.now();
  s.write(hello);
  await sleep(100);
  s.write(Buffer.from([0x17, 0x03, 0x03, 0x40, 0x00]));
  const drip = setInterval(() => !s.destroyed && s.write(Buffer.from([0x41])), 200);
  await new Promise((r) => s.once("close", r));
  clearInterval(drip);
  const ms = Date.now() - t0;
  assert.ok(ms < 2500, `closed after ${ms} ms`);
});

/** A real ClientHello for `servername`. */
async function captureHello(servername: string): Promise<Buffer> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const got = new Promise<Buffer>((r) =>
    srv.once("connection", (c) => c.once("data", (b: Buffer) => (r(b), c.destroy()))),
  );
  const c = tls.connect({
    host: "127.0.0.1",
    port: (srv.address() as net.AddressInfo).port,
    servername,
    rejectUnauthorized: false,
  });
  c.on("error", () => {});
  const b = await got;
  c.destroy();
  srv.close();
  return b;
}

// Keep the signing helpers referenced for readers comparing with relay-login.
void signProof;
void proofPayload;
