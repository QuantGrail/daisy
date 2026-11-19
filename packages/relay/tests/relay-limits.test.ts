/**
 * P5-01 (plan 7.6 "基本的自我保护", ADR-143 §5): every limit in config.ts
 * enforced — refused first. Small limits per test so each runs in a second
 * or two.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import tls from "node:tls";
import { WebSocket } from "ws";
import { fixture, until, sleep, DOMAIN, type Fixture } from "./helpers/fixture.ts";
import { call, dataUpgrade, handshake, localLookup } from "./helpers/daisy-side.ts";
import { CLAIM_HEADER, CLOSE } from "../src/protocol.ts";

/** A raw TCP connection to the public port: what came back, and when it closed. */
function rawTcp(port: number) {
  const s = net.connect(port, "127.0.0.1");
  const got: Buffer[] = [];
  const t0 = Date.now();
  s.on("data", (b: Buffer) => got.push(b));
  s.on("error", () => {});
  const closed = new Promise<{ ms: number; got: Buffer }>((r) =>
    s.on("close", () => r({ ms: Date.now() - t0, got: Buffer.concat(got) })),
  );
  return { s, closed };
}

/** A real ClientHello for `servername` (captured from Node's TLS client). */
async function realHello(servername: string): Promise<Buffer> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const got = new Promise<Buffer>((r) =>
    srv.once("connection", (c) => c.once("data", (b: Buffer) => (r(b), c.destroy()))),
  );
  const c = tls.connect({ host: "127.0.0.1", port: (srv.address() as net.AddressInfo).port, servername });
  c.on("error", () => {});
  const b = await got;
  c.destroy();
  srv.close();
  return b;
}

const publicCount = (f: Fixture) => f.relay.state().publicConnections;

test("refused: slowloris ClientHello (a byte at a time) is dropped at the absolute deadline", async (t) => {
  const f = await fixture({ clientHelloTimeoutMs: 600 });
  t.after(() => f.close());
  const hello = await realHello(`${"a".repeat(32)}.${DOMAIN}`);
  const c = rawTcp(f.relay.port);
  let i = 0;
  const drip = setInterval(() => {
    if (i < hello.length && !c.s.destroyed) c.s.write(hello.subarray(i, ++i));
  }, 50);
  const r = await c.closed;
  clearInterval(drip);
  assert.ok(r.ms >= 500 && r.ms < 2000, `dropped after ${r.ms} ms`);
  assert.equal(r.got.length, 0, "nothing answered");
  // Silence (connect and send nothing) the same.
  const quiet = await rawTcp(f.relay.port).closed;
  assert.ok(quiet.ms >= 500 && quiet.ms < 2000);
  await until(() => publicCount(f) === 0, 2000, "slots released");
});

test("refused: oversized, malformed and non-TLS hellos are closed without an answer", async (t) => {
  const f = await fixture({ maxClientHelloBytes: 4096 });
  t.after(() => f.close());
  const cases: [string, Buffer][] = [
    ["plain HTTP", Buffer.from("GET / HTTP/1.1\r\nHost: relay.test\r\n\r\n")],
    ["record longer than TLS allows", Buffer.from([22, 3, 1, 0x48, 0x01, 1, 0, 0, 10])],
    ["ClientHello claiming 1 MB", Buffer.from([22, 3, 1, 0x10, 0x00, 1, 0x10, 0, 0])],
    ["not a ClientHello", Buffer.from([22, 3, 1, 0, 4, 2, 0, 0, 0])],
    ["application data first", Buffer.from([23, 3, 3, 0, 1, 0])],
    ["empty record", Buffer.from([22, 3, 1, 0, 0])],
  ];
  for (const [name, bytes] of cases) {
    const c = rawTcp(f.relay.port);
    c.s.write(bytes);
    const r = await c.closed;
    assert.ok(r.ms < 1000, `${name}: closed after ${r.ms} ms`);
    assert.equal(r.got.length, 0, `${name}: nothing answered`);
  }
  // A ClientHello that keeps growing past the cap across many records.
  const c = rawTcp(f.relay.port);
  const rec = Buffer.concat([
    Buffer.from([22, 3, 1, 0x03, 0xe8]),
    Buffer.from([1, 0x00, 0xff, 0xff]),
    Buffer.alloc(996),
  ]);
  c.s.write(rec);
  for (let i = 0; i < 6 && !c.s.destroyed; i++)
    c.s.write(Buffer.concat([Buffer.from([22, 3, 1, 0x03, 0xe8]), Buffer.alloc(1000)]));
  assert.ok((await c.closed).ms < 1000);
  await until(() => publicCount(f) === 0, 2000, "slots released");
  assert.equal(f.relay.state().heldBytes, 0);
});

test("refused: connections per address, new connections per address, all connections", async (t) => {
  const f = await fixture({ maxConnectionsPerIp: 3, newConnectionsPerIpBurst: 100 });
  t.after(() => f.close());
  const open = [rawTcp(f.relay.port), rawTcp(f.relay.port), rawTcp(f.relay.port)];
  await until(() => publicCount(f) === 3, 2000, "three open");
  const fourth = await rawTcp(f.relay.port).closed;
  assert.ok(fourth.ms < 500, "the fourth is closed at once");
  for (const o of open) o.s.destroy();
  await until(() => publicCount(f) === 0, 2000, "closed");

  const g = await fixture({ newConnectionsPerIpPerSec: 1, newConnectionsPerIpBurst: 4 });
  t.after(() => g.close());
  const quick = [0, 1, 2, 3, 4, 5].map(() => rawTcp(g.relay.port));
  await sleep(200);
  const alive = quick.filter((q) => !q.s.destroyed && q.s.readyState === "open");
  const results = await Promise.race([Promise.all(quick.slice(4).map((q) => q.closed)), sleep(1000).then(() => null)]);
  assert.ok(results, "connections over the burst were closed at once");
  assert.ok(alive.length <= 4);
  for (const q of quick) q.s.destroy();

  const h = await fixture({ maxPublicConnections: 2, maxConnectionsPerIp: 100 });
  t.after(() => h.close());
  const two = [rawTcp(h.relay.port), rawTcp(h.relay.port)];
  await until(() => h.relay.state().publicConnections === 2, 2000, "two open");
  assert.ok((await rawTcp(h.relay.port).closed).ms < 500);
  for (const o of two) o.s.destroy();
});

test("refused: streams per Daisy (waiting and total) and new streams per second", async (t) => {
  const f = await fixture({ maxPendingPerDaisy: 2, maxStreamsPerDaisy: 3, claimTimeoutMs: 3000 });
  t.after(() => f.close());
  const silent = f.daisy({ silent: true });
  await silent.start();
  const waiting = [handshake(f.relay.port, silent.host, f.ca.cert), handshake(f.relay.port, silent.host, f.ca.cert)];
  await until(() => f.relay.state().pending === 2, 2000, "two waiting");
  const third = await handshake(f.relay.port, silent.host, f.ca.cert);
  assert.match(third.message ?? "", /internal error/, "the third waiting stream is refused");
  assert.ok(third.ms < 1000);
  for (const o of silent.opens) silent.reject(o.claim);
  await Promise.all(waiting);
  assert.equal(f.relay.state().pending, 0);

  const g = await fixture({ opensPerDaisyPerSec: 1, opensPerDaisyBurst: 3 });
  t.after(() => g.close());
  const d = g.daisy();
  await d.start();
  for (let i = 0; i < 3; i++) assert.equal((await call(g.relay.port, d.host, g.ca.cert)).status, 200);
  const over = await handshake(g.relay.port, d.host, g.ca.cert);
  assert.match(over.message ?? "", /internal error/, "the fourth stream within the second is refused");
  assert.ok(g.logs.some((l) => JSON.parse(l).reason === "rate_limited"));
});

test("refused: a stream over its byte cap, idle too long, or alive too long is cut", async (t) => {
  const f = await fixture({ maxStreamBytes: 64 * 1024, streamIdleTimeoutMs: 400, maxStreamDurationMs: 1500 });
  t.after(() => f.close());
  const d = f.daisy();
  await d.start();
  // Under the cap: fine.
  assert.equal((await call(f.relay.port, d.host, f.ca.cert, { method: "POST", body: "x".repeat(10_000) })).status, 200);
  // Over it: cut.
  await assert.rejects(call(f.relay.port, d.host, f.ca.cert, { method: "POST", body: "x".repeat(200_000) }));
  await until(() => f.logs.some((l) => JSON.parse(l).reason === "too_many_bytes"), 2000, "byte cap logged");
  // Idle: a TLS connection that says nothing after the handshake.
  const s = tls.connect({ host: "127.0.0.1", port: f.relay.port, servername: d.host, ca: f.ca.cert });
  s.on("error", () => {});
  await new Promise((r) => s.once("secureConnect", r));
  const t0 = Date.now();
  await new Promise((r) => s.once("close", r));
  const idle = Date.now() - t0;
  assert.ok(idle >= 300 && idle < 1500, `idle stream closed after ${idle} ms`);
  // Alive too long even though busy: a request every 200 ms.
  const s2 = tls.connect({ host: "127.0.0.1", port: f.relay.port, servername: d.host, ca: f.ca.cert });
  s2.on("error", () => {});
  s2.on("data", () => {});
  await new Promise((r) => s2.once("secureConnect", r));
  const t1 = Date.now();
  const keep = setInterval(() => s2.write("GET / HTTP/1.1\r\nhost: x\r\n\r\n"), 200);
  await new Promise((r) => s2.once("close", r));
  clearInterval(keep);
  const life = Date.now() - t1;
  assert.ok(life >= 1200 && life < 3000, `stream closed at its maximum life after ${life} ms`);
  assert.ok(f.logs.some((l) => JSON.parse(l).reason === "max_duration"));
});

test("throttled: bytes per second per Daisy", async (t) => {
  const f = await fixture({ bytesPerSecPerDaisy: 100_000 });
  t.after(() => f.close());
  const d = f.daisy({ handler: (_q, res) => res.end("y".repeat(300_000)) });
  await d.start();
  const t0 = Date.now();
  const r = await call(f.relay.port, d.host, f.ca.cert);
  const ms = Date.now() - t0;
  assert.equal(r.body.length, 300_000);
  // ~300 kB at 100 kB/s with a 100 kB burst: about 2 s.
  assert.ok(ms >= 1500, `took ${ms} ms`);
});

test("refused: control messages — too many, too big, binary; a Daisy that stops answering pings goes offline", async (t) => {
  const f = await fixture({ controlMessagesPerSec: 1, controlMessagesBurst: 5, maxControlMessageBytes: 1024 });
  t.after(() => f.close());
  const d = f.daisy({ backoff: { baseMs: 60_000, maxMs: 60_000 } });
  await d.start();
  let closed = new Promise<number>((r) => d.once("closed", r));
  for (let i = 0; i < 10; i++) d.sendControl(JSON.stringify({ t: "noop", v: 1 }));
  assert.equal(await closed, CLOSE.rateLimited);

  const d2 = f.daisy({ backoff: { baseMs: 60_000, maxMs: 60_000 } });
  await d2.start();
  closed = new Promise<number>((r) => d2.once("closed", r));
  d2.sendControl(JSON.stringify({ t: "noop", v: 1, pad: "x".repeat(2000) }));
  assert.equal(await closed, 1009, "message too big");

  const d3 = f.daisy({ backoff: { baseMs: 60_000, maxMs: 60_000 } });
  await d3.start();
  closed = new Promise<number>((r) => d3.once("closed", r));
  d3.sendControl(Buffer.from([1, 2, 3]));
  assert.equal(await closed, CLOSE.protocol);

  const g = await fixture({ pingIntervalMs: 300 });
  t.after(() => g.close());
  const quiet = g.daisy({ backoff: { baseMs: 60_000, maxMs: 60_000 } });
  await quiet.start();
  // Stop reading: pings go unanswered.
  (quiet as unknown as { ws: WebSocket }).ws.pause();
  const ms = await until(() => g.relay.state().online.length === 0, 3000, "dropped");
  assert.ok(ms < 1500, `dropped after ${ms} ms`);
});

test("refused: data frames over the cap; text frames after the claim", async (t) => {
  const f = await fixture({ maxDataFrameBytes: 4096 });
  t.after(() => f.close());
  // A Daisy that splits its writes (as the welcome says) is fine…
  const d = f.daisy({ handler: (_q, res) => res.end("z".repeat(50_000)) });
  const w = await d.start();
  assert.equal(w.limits.maxDataFrameBytes, 4096);
  assert.equal((await call(f.relay.port, d.host, f.ca.cert)).body.length, 50_000);
  // …one frame over the cap closes the stream (1009).
  const quiet = f.daisy({ silent: true });
  await quiet.start();
  const caller = handshake(f.relay.port, quiet.host, f.ca.cert);
  await until(() => quiet.opens.length === 1, 2000, "open");
  const up = await dataUpgrade(f.relay.port, f.ca.cert, { [CLAIM_HEADER]: quiet.opens[0]!.claim });
  assert.equal(up.status, 101);
  const closedWith = new Promise<number>((r) => up.ws!.once("close", r));
  up.ws!.send(Buffer.alloc(8192, 0x17));
  assert.equal(await closedWith, 1009);
  assert.equal((await caller).ok, false);
  await until(() => f.relay.state().streams === 0, 2000, "stream gone");

  const g = await fixture();
  t.after(() => g.close());
  const silent = g.daisy({ silent: true });
  await silent.start();
  const pending = handshake(g.relay.port, silent.host, g.ca.cert);
  await until(() => silent.opens.length === 1, 2000, "open");
  const up2 = await dataUpgrade(g.relay.port, g.ca.cert, { [CLAIM_HEADER]: silent.opens[0]!.claim });
  assert.equal(up2.status, 101);
  const ws = up2.ws!;
  if (!up2.got.length) await new Promise((r) => ws.once("message", r)); // the ClientHello
  ws.send("text is not allowed now");
  const r = await pending;
  assert.equal(r.ok, false);
  await until(() => g.relay.state().streams === 0, 2000, "stream gone");
  assert.ok(g.logs.some((l) => JSON.parse(l).reason === "text_frame"));
});

test("refused: the relay's own HTTPS — slow headers, huge headers, too many requests, unknown paths and methods", async (t) => {
  const f = await fixture({
    ownHeadersTimeoutMs: 500,
    maxHeaderBytes: 2048,
    ownRequestsPerIpPerSec: 1,
    ownRequestsPerIpBurst: 8,
  });
  t.after(() => f.close());
  const own = () => tls.connect({ host: "127.0.0.1", port: f.relay.port, servername: DOMAIN, ca: f.ca.cert });
  const exchange = (text: string) =>
    new Promise<{ head: string; ms: number }>((resolve) => {
      const s = own();
      const t0 = Date.now();
      let got = "";
      s.on("error", () => {});
      s.on("secureConnect", () => s.write(text));
      s.on("data", (b) => (got += b.toString()));
      s.on("close", () => resolve({ head: got.split("\r\n")[0] ?? "", ms: Date.now() - t0 }));
    });
  // Slow headers: never finished.
  const slow = await exchange("GET /v1/info HTTP/1.1\r\nhost: relay.test\r\n");
  assert.ok(slow.ms >= 400 && slow.ms < 2000, `slow headers dropped after ${slow.ms} ms`);
  assert.equal(slow.head, "");
  // …also when trickled a byte at a time (the deadline is absolute, not idle).
  const trickle = await new Promise<number>((resolve) => {
    const s = own();
    const t0 = Date.now();
    s.on("error", () => {});
    let timer: NodeJS.Timeout | undefined;
    s.on("secureConnect", () => {
      timer = setInterval(() => s.write("a"), 50) as unknown as NodeJS.Timeout;
      s.write("GET /v1/info HTTP/1.1\r\nx-slow: ");
    });
    s.on("close", () => {
      clearInterval(timer);
      resolve(Date.now() - t0);
    });
  });
  assert.ok(trickle >= 400 && trickle < 2000, `trickled headers dropped after ${trickle} ms`);
  // Huge headers.
  const huge = await exchange(
    `GET /v1/info HTTP/1.1\r\nhost: relay.test\r\nx: ${"a".repeat(4000)}\r\nconnection: close\r\n\r\n`,
  );
  assert.ok(!/ 200 /.test(huge.head) && huge.ms < 1000, `huge headers: ${huge.head || "closed"} after ${huge.ms} ms`);
  // Unknown path, method.
  assert.match((await exchange("GET /admin HTTP/1.1\r\nhost: relay.test\r\nconnection: close\r\n\r\n")).head, / 404 /);
  assert.match(
    (await exchange("POST /v1/info HTTP/1.1\r\nhost: relay.test\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"))
      .head,
    / 405 /,
  );
  assert.match(
    (await exchange("GET /v1/presence/NOT-A-SUB HTTP/1.1\r\nhost: relay.test\r\nconnection: close\r\n\r\n")).head,
    / 400 /,
  );
  // Too many: the burst runs out.
  let limited = false;
  for (let i = 0; i < 12 && !limited; i++) {
    const r = await exchange("GET /v1/info HTTP/1.1\r\nhost: relay.test\r\nconnection: close\r\n\r\n");
    if (/ 429 /.test(r.head)) limited = true;
  }
  assert.ok(limited, "429 once the burst is used");
  // A TLS handshake that never finishes on the relay's own name.
  const g = await fixture({ ownTlsHandshakeTimeoutMs: 400 });
  t.after(() => g.close());
  const hello = await realHello(DOMAIN);
  const c = rawTcp(g.relay.port);
  c.s.write(hello);
  const r = await c.closed;
  assert.ok(r.ms < 2500, `half handshake dropped after ${r.ms} ms`);
});
