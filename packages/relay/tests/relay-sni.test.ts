/**
 * P5-01 (ADR-143 §3): the ClientHello reader — real hellos from Node's TLS
 * client, cut and re-fragmented every way; malformed ones refused; random
 * and mutated input never throws.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import tls from "node:tls";
import { randomBytes } from "node:crypto";
import { parseClientHello, alertRecord } from "../src/sni.ts";

async function realHello(o: tls.ConnectionOptions): Promise<Buffer> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const got = new Promise<Buffer>((resolve) =>
    srv.once("connection", (c) => {
      const parts: Buffer[] = [];
      c.on("data", (b: Buffer) => {
        parts.push(b);
        const all = Buffer.concat(parts);
        if (parseClientHello(all, 1 << 16).state !== "need") {
          resolve(all);
          c.destroy();
        }
      });
    }),
  );
  const c = tls.connect({ host: "127.0.0.1", port: (srv.address() as net.AddressInfo).port, ...o });
  c.on("error", () => {});
  const b = await got;
  c.destroy();
  srv.close();
  return b;
}

/** The handshake bytes of a hello, re-cut into records of `size`. */
function refragment(hello: Buffer, size: number): Buffer {
  const body: Buffer[] = [];
  let o = 0;
  while (o < hello.length) {
    const len = hello.readUInt16BE(o + 3);
    body.push(hello.subarray(o + 5, o + 5 + len));
    o += 5 + len;
  }
  const hs = Buffer.concat(body);
  const out: Buffer[] = [];
  for (let i = 0; i < hs.length; i += size) {
    const part = hs.subarray(i, i + size);
    out.push(Buffer.from([22, 3, 1, part.length >> 8, part.length & 255]), part);
  }
  return Buffer.concat(out);
}

const HOST = "abcdefghijklmnopqrstuvwxyz234567.relay.test";

test("reads the SNI of real ClientHellos (TLS 1.3 and 1.2), whole, byte by byte, and across many records", async () => {
  for (const o of [
    { servername: HOST },
    { servername: HOST, maxVersion: "TLSv1.2" as const },
    { servername: "RELAY.Test" },
  ]) {
    const h = await realHello(o);
    const want = o.servername.toLowerCase();
    assert.deepEqual(parseClientHello(h, 16384), { state: "ok", sni: want });
    // Every prefix is "need", until the whole thing.
    for (let i = 0; i < h.length; i++)
      assert.equal(parseClientHello(h.subarray(0, i), 16384).state, "need", `prefix ${i}`);
    // The same hello in records of 1, 7, 100 bytes.
    for (const size of [1, 7, 100]) {
      const r = refragment(h, size);
      assert.deepEqual(parseClientHello(r, 1 << 16), { state: "ok", sni: want }, `records of ${size}`);
    }
    // Trailing bytes after the hello (another record) do not matter.
    assert.deepEqual(parseClientHello(Buffer.concat([h, Buffer.from([20, 3, 3, 0, 1, 1])]), 16384), {
      state: "ok",
      sni: want,
    });
  }
});

test("a ClientHello without SNI is ok with sni null (the relay then refuses it)", async () => {
  const h = await realHello({ servername: "" });
  assert.deepEqual(parseClientHello(h, 16384), { state: "ok", sni: null });
});

/** A minimal ClientHello with the given extensions block. */
function hello(exts: Buffer | null, o: { sid?: number; suites?: number; comp?: number } = {}): Buffer {
  const sid = o.sid ?? 0;
  const suites = o.suites ?? 2;
  const comp = o.comp ?? 1;
  const parts: Buffer[] = [
    Buffer.from([3, 3]),
    Buffer.alloc(32, 1),
    Buffer.from([sid]),
    Buffer.alloc(Math.min(sid, 32)),
    Buffer.from([suites >> 8, suites & 255]),
    Buffer.alloc(suites, 0x13),
    Buffer.from([comp]),
    Buffer.alloc(comp),
  ];
  if (exts) parts.push(Buffer.from([exts.length >> 8, exts.length & 255]), exts);
  const body = Buffer.concat(parts);
  const hs = Buffer.concat([Buffer.from([1, body.length >> 16, (body.length >> 8) & 255, body.length & 255]), body]);
  return Buffer.concat([Buffer.from([22, 3, 1, hs.length >> 8, hs.length & 255]), hs]);
}
const ext = (type: number, data: Buffer) =>
  Buffer.concat([Buffer.from([type >> 8, type & 255, data.length >> 8, data.length & 255]), data]);
const names = (...list: [number, string][]) => {
  const items = Buffer.concat(
    list.map(([t, n]) => Buffer.concat([Buffer.from([t, n.length >> 8, n.length & 255]), Buffer.from(n, "latin1")])),
  );
  return Buffer.concat([Buffer.from([items.length >> 8, items.length & 255]), items]);
};

test("refused: malformed SNI and ClientHellos", () => {
  const bad = (b: Buffer, why: string) => {
    const r = parseClientHello(b, 16384);
    assert.equal(r.state, "bad", why);
  };
  assert.deepEqual(parseClientHello(hello(ext(0, names([0, "a.relay.test"]))), 16384), {
    state: "ok",
    sni: "a.relay.test",
  });
  bad(hello(ext(0, names([0, "a.relay.test"], [0, "b.relay.test"]))), "two host names");
  bad(
    hello(Buffer.concat([ext(0, names([0, "a.relay.test"])), ext(0, names([0, "b.relay.test"]))])),
    "two SNI extensions",
  );
  bad(hello(ext(0, names([0, "a.relay.test."]))), "trailing dot");
  bad(hello(ext(0, names([0, "a_b.relay.test"]))), "underscore");
  bad(hello(ext(0, names([0, "a b.relay.test"]))), "space");
  bad(hello(ext(0, names([0, "a.relay.test\u0000x"]))), "NUL");
  bad(hello(ext(0, names([0, "é.relay.test"]))), "non-ASCII");
  bad(hello(ext(0, names([0, "x".repeat(64) + ".relay.test"]))), "label over 63");
  bad(hello(ext(0, names([1, "a.relay.test"]))), "no host_name entry");
  bad(hello(ext(0, Buffer.from([0, 9, 0, 0, 1, 97]))), "list length wrong");
  bad(hello(ext(0, names([0, "a.relay.test"])), { sid: 33 }), "session id over 32");
  bad(hello(null, { suites: 3 }), "odd cipher suites");
  bad(hello(null, { suites: 0 }), "no cipher suites");
  bad(hello(null, { comp: 0 }), "no compression methods");
  const h = hello(ext(0, names([0, "a.relay.test"])));
  const lying = Buffer.from(h);
  lying[lying.length - ext(0, names([0, "a.relay.test"])).length - 1]! += 1; // extensions length off by one
  bad(lying, "extensions length");
  bad(Buffer.from([23, 3, 3, 0, 5, 1, 2, 3, 4, 5]), "not a handshake record");
  bad(Buffer.from([22, 2, 0, 0, 5, 1, 0, 0, 1, 0]), "not TLS 3.x");
  bad(Buffer.from([22, 3, 1, 0, 0]), "empty record");
  bad(Buffer.from([22, 3, 1, 0x40, 0x01]), "record over 16384");
  bad(Buffer.from([22, 3, 1, 0, 4, 2, 0, 0, 0]), "ServerHello, not ClientHello");
  bad(Buffer.from([22, 3, 1, 0, 4, 1, 0x01, 0, 0]), "ClientHello longer than the cap");
  assert.deepEqual(parseClientHello(hello(null), 16384), { state: "ok", sni: null }, "no extensions at all");
  // Past the byte cap while still incomplete.
  assert.equal(
    parseClientHello(Buffer.concat([Buffer.from([22, 3, 1, 0x40, 0x00]), Buffer.alloc(100)]), 1000).state,
    "bad",
  );
});

test("random and mutated input never throws and never invents a name", async () => {
  const h = await realHello({ servername: HOST });
  for (let i = 0; i < 3000; i++) {
    const r = parseClientHello(randomBytes(1 + (i % 600)), 16384);
    assert.ok(["need", "ok", "bad"].includes(r.state));
  }
  for (let i = 0; i < 3000; i++) {
    const m = Buffer.from(h);
    for (let k = 0; k < 1 + (i % 4); k++) m[Math.floor(Math.random() * m.length)] = Math.floor(Math.random() * 256);
    const r = parseClientHello(m, 16384);
    if (r.state === "ok" && r.sni !== null) assert.match(r.sni, /^[a-z0-9.-]+$/);
  }
});

test("the refusal is one fatal TLS alert record", () => {
  assert.deepEqual([...alertRecord(112)], [0x15, 3, 3, 0, 2, 2, 112]);
});
