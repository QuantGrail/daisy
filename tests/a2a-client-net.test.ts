/**
 * P4-08 (ADR-127 §4, the P4-01 security review's SSRF item): the A2A
 * client's outbound connections (packages/daisy/src/a2a/client/net.ts,
 * peer.ts). Refusals first: loopback, ::1, the metadata address, 0.0.0.0,
 * a name resolving to loopback, a name resolving to a mix, IPv4 hidden in
 * IPv6, private ranges for relay addresses, plain http to the internet,
 * a redirect; then pinning (one lookup, the checked address connected
 * to), caps, time limits, TLS (no byte written before the certificate is
 * accepted), and the card's interfaces kept to the contact's own origin.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createServer as createTls } from "node:https";
import { createServer as createNet } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  A2APeer,
  OutboundError,
  PeerError,
  addressRefusal,
  classifyAddress,
  outboundRequest,
  resolveChecked,
} from "../packages/daisy/src/a2a/client/index.ts";
import { tlsMaterial } from "../packages/daisy/src/access/tls.ts";

const LOOPBACK_OK = { allowLoopback: true };

/** A server on 127.0.0.1 that counts connections and requests. */
async function local(handler: (req: any, res: any) => void = (_q, s) => s.end("{}")) {
  let connections = 0,
    requests = 0;
  const srv: Server = createServer((q, s) => {
    requests++;
    handler(q, s);
  });
  srv.on("connection", () => connections++);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as any).port as number;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    counts: () => ({ connections, requests }),
    close: () => new Promise<void>((r) => srv.close(() => r())),
  };
}

const req = (url: string, more: Partial<Parameters<typeof outboundRequest>[0]> = {}) =>
  outboundRequest({ url, kind: "direct", method: "GET", timeoutMs: 2000, maxBytes: 4096, ...more });

async function refused(p: Promise<unknown>, code: string, msg?: RegExp) {
  await assert.rejects(p, (e: any) => {
    assert.ok(e instanceof OutboundError, String(e));
    assert.equal(e.code, code, e.message);
    if (msg) assert.match(e.message, msg);
    return true;
  });
}

// ── refusals first ────────────────────────────────────────────────────────

test("SSRF: loopback, ::1, the metadata address, 0.0.0.0 are never connected to (direct or relay)", async () => {
  const s = await local();
  try {
    for (const kind of ["direct", "relay"] as const) {
      const scheme = kind === "relay" ? "https" : "http";
      await refused(req(`${scheme}://127.0.0.1:${s.port}/a2a`, { kind }), "refused_address", /回环/);
      await refused(req(`${scheme}://127.1.2.3:${s.port}/`, { kind }), "refused_address", /回环/);
      await refused(req(`${scheme}://[::1]:${s.port}/`, { kind }), "refused_address", /回环/);
      await refused(req(`${scheme}://169.254.169.254/latest/meta-data/`, { kind }), "refused_address", /元数据/);
      await refused(req(`${scheme}://[fd00:ec2::254]/`, { kind }), "refused_address", /元数据/);
      await refused(req(`${scheme}://0.0.0.0:${s.port}/`, { kind }), "refused_address", /未指定/);
      await refused(req(`${scheme}://[::]:${s.port}/`, { kind }), "refused_address", /未指定/);
      await refused(req(`${scheme}://169.254.10.1/`, { kind }), "refused_address", /链路本地/);
      await refused(req(`${scheme}://[fe80::1]/`, { kind }), "refused_address", /链路本地/);
      // IPv4 hidden in IPv6: mapped, NAT64, 6to4.
      await refused(req(`${scheme}://[::ffff:127.0.0.1]:${s.port}/`, { kind }), "refused_address", /回环/);
      await refused(req(`${scheme}://[::ffff:169.254.169.254]/`, { kind }), "refused_address", /元数据/);
      await refused(req(`${scheme}://[64:ff9b::7f00:1]:${s.port}/`, { kind }), "refused_address", /回环/);
      await refused(req(`${scheme}://[2002:7f00:1::1]/`, { kind }), "refused_address", /回环/);
      // A name that resolves to loopback (the real resolver: localhost).
      await refused(req(`${scheme}://localhost:${s.port}/`, { kind }), "refused_address", /回环/);
    }
    // Nothing reached the server.
    assert.deepEqual(s.counts(), { connections: 0, requests: 0 });
  } finally {
    await s.close();
  }
});

test("SSRF: a name with any refused address is refused as a whole; relay addresses refuse private ranges, direct ones allow them", async () => {
  const lookup = async (h: string) =>
    h === "rebind.example"
      ? [
          { address: "93.184.216.34", family: 4 },
          { address: "127.0.0.1", family: 4 },
        ]
      : h === "meta.example"
        ? [{ address: "169.254.169.254", family: 4 }]
        : h === "lan.example"
          ? [{ address: "10.1.2.3", family: 4 }]
          : [{ address: "93.184.216.34", family: 4 }];
  await refused(resolveChecked("rebind.example", "direct", false, { lookup }), "refused_address", /回环/);
  await refused(resolveChecked("meta.example", "relay", false, { lookup }), "refused_address", /元数据/);
  await refused(resolveChecked("lan.example", "relay", false, { lookup }), "refused_address", /中转地址不能指向内网/);
  assert.equal(await resolveChecked("lan.example", "direct", true, { lookup }), "10.1.2.3");
  for (const ip of ["10.0.0.5", "172.16.0.1", "192.168.1.1", "100.64.0.1", "fc00::1", "fd12:3456::1"]) {
    assert.equal(classifyAddress(ip), "private", ip);
    assert.match(addressRefusal("private", "relay")!, /内网/);
    assert.equal(addressRefusal("private", "direct"), null);
  }
  // Plain http only inside a private network; relay only over https.
  await refused(resolveChecked("public.example", "direct", true, { lookup }), "refused_address", /明文 http/);
  await refused(req("http://relay.example/", { kind: "relay" }), "bad_url", /https/);
  // URLs: no credentials, no other schemes.
  await refused(req("http://user:pw@10.0.0.1/"), "bad_url", /用户名/);
  await refused(req("file:///etc/passwd"), "bad_url");
  await refused(req("ftp://10.0.0.1/"), "bad_url");
  // The test seam allows loopback only, nothing else.
  assert.equal(addressRefusal("loopback", "direct", LOOPBACK_OK), null);
  for (const c of ["metadata", "link-local", "unspecified", "multicast", "reserved"] as const)
    assert.ok(addressRefusal(c, "direct", LOOPBACK_OK), c);
});

test("address classes", () => {
  const cases: [string, string][] = [
    ["127.0.0.1", "loopback"],
    ["::1", "loopback"],
    ["0.0.0.0", "unspecified"],
    ["0.1.2.3", "unspecified"],
    ["::", "unspecified"],
    ["169.254.169.254", "metadata"],
    ["169.254.170.2", "metadata"],
    ["100.100.100.200", "metadata"],
    ["168.63.129.16", "metadata"],
    ["fd00:ec2::254", "metadata"],
    ["169.254.1.1", "link-local"],
    ["fe80::abcd", "link-local"],
    ["224.0.0.1", "multicast"],
    ["ff02::1", "multicast"],
    ["255.255.255.255", "reserved"],
    ["192.0.2.1", "reserved"],
    ["2001:db8::1", "reserved"],
    ["2001:0:4136:e378::1", "reserved"],
    ["::ffff:10.0.0.1", "private"],
    ["::ffff:8.8.8.8", "public"],
    ["64:ff9b::808:808", "public"],
    ["8.8.8.8", "public"],
    ["2606:4700::1111", "public"],
    ["fe80::1%en0", "reserved"],
  ];
  for (const [ip, cls] of cases) assert.equal(classifyAddress(ip), cls, ip);
  assert.equal(classifyAddress("example.com"), null);
});

test("no redirect is followed; the answer is capped in bytes and the exchange in time", async () => {
  const target = await local();
  const redirect = await local((_q, s) => {
    s.writeHead(302, { location: `${target.url}/secret` });
    s.end();
  });
  const big = await local((_q, s) => s.end("x".repeat(10_000)));
  const bigDeclared = await local((_q, s) => {
    s.writeHead(200, { "content-length": "99999999" });
    s.end("x");
  });
  const silent = await local(() => {});
  try {
    await refused(req(`${redirect.url}/a2a`, { policy: LOOPBACK_OK }), "redirect", /跳转/);
    assert.deepEqual(target.counts(), { connections: 0, requests: 0 });
    await refused(req(big.url, { policy: LOOPBACK_OK }), "too_large");
    await refused(req(bigDeclared.url, { policy: LOOPBACK_OK }), "too_large");
    const t0 = Date.now();
    await refused(req(silent.url, { policy: LOOPBACK_OK, timeoutMs: 300 }), "timeout");
    assert.ok(Date.now() - t0 < 2000);
    // Allowed in the tests' seam: a normal answer.
    const ok = await req(target.url, { policy: LOOPBACK_OK });
    assert.equal(ok.status, 200);
    assert.equal(ok.address, "127.0.0.1");
  } finally {
    for (const s of [target, redirect, big, bigDeclared, silent]) await s.close();
  }
});

test("DNS is asked once and the checked address is the one connected to (no rebinding between check and connect)", async () => {
  const s = await local((q, r) => r.end(JSON.stringify({ host: q.headers.host })));
  try {
    let asked = 0;
    const lookup = async () => {
      asked++;
      // A rebinding resolver: loopback first, then the metadata address.
      return asked === 1 ? [{ address: "127.0.0.1", family: 4 }] : [{ address: "169.254.169.254", family: 4 }];
    };
    const r = await req(`http://daisy-b.example:${s.port}/a2a`, { policy: { ...LOOPBACK_OK, lookup } });
    assert.equal(asked, 1);
    assert.equal(r.address, "127.0.0.1");
    // Host keeps the name (and the port: the other side's guard checks it).
    assert.deepEqual(JSON.parse(r.body.toString()), { host: `daisy-b.example:${s.port}` });
  } finally {
    await s.close();
  }
});

test("TLS: a certificate no CA vouches for is refused unless the check accepts it — and nothing is written before", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-tls-"));
  let requests = 0;
  const srv = createTls(tlsMaterial(dir, "127.0.0.1"), (_q, s) => {
    requests++;
    s.end("{}");
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const url = `https://127.0.0.1:${(srv.address() as any).port}/a2a`;
  try {
    await refused(req(url, { policy: LOOPBACK_OK }), "tls", /不受信任/);
    const seen: any[] = [];
    await refused(
      req(url, {
        policy: LOOPBACK_OK,
        tlsCheck: (x) => {
          seen.push(x);
          return "证书变了";
        },
      }),
      "tls",
      /证书变了/,
    );
    assert.equal(requests, 0);
    assert.equal(seen[0].authorized, false);
    assert.match(seen[0].fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(seen[0].origin, url.replace(/\/a2a$/, ""));
    const ok = await req(url, { policy: LOOPBACK_OK, tlsCheck: (x) => x.fingerprint === seen[0].fingerprint || "不对" });
    assert.equal(ok.status, 200);
    assert.equal(requests, 1);
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a peer: the card's interfaces must be on the contact's own origin; tokens are fresh per request; 401/404/429 are told apart", async () => {
  const other = await local((_q, s) => s.end("{}"));
  let card: any = {};
  let status = 200;
  const auth: string[] = [];
  const s = await local((q, r) => {
    auth.push(String(q.headers.authorization));
    if (status !== 200) {
      r.writeHead(status, status === 429 ? { "retry-after": "7" } : {});
      return r.end(JSON.stringify({ error: { code: status, message: "对方的话", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: status === 429 ? "RESOURCE_EXHAUSTED" : "X" }] } }));
    }
    r.end(JSON.stringify(q.url.endsWith("/a2a") ? { agents: [{ agentId: "a1", name: "研究助手" }, { agentId: 5 }] } : card));
  });
  try {
    let n = 0;
    const peer = new A2APeer({ root: s.url, kind: "direct", policy: LOOPBACK_OK, token: async () => `tok-${++n}` });
    assert.deepEqual(await peer.directory(), [{ agentId: "a1", name: "研究助手" }]);
    card = { name: "研究助手", supportedInterfaces: [{ url: `${other.url}/a2a/a1/jsonrpc`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }] };
    await assert.rejects(peer.card("a1"), (e: any) => e instanceof PeerError && e.kind === "protocol");
    card = {
      name: "研究助手",
      supportedInterfaces: [
        { url: `${other.url}/a2a/a1/jsonrpc`, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
        { url: `${s.url}/a2a/a1`, protocolBinding: "HTTP+JSON", protocolVersion: "1.0" },
      ],
    };
    const c = await peer.card("a1");
    assert.equal(c.binding, "HTTP+JSON");
    assert.equal(c.url, `${s.url}/a2a/a1`);
    assert.deepEqual(other.counts(), { connections: 0, requests: 0 });
    assert.deepEqual(auth, ["Bearer tok-1", "Bearer tok-2", "Bearer tok-3"]);
    status = 401;
    await assert.rejects(peer.directory(), (e: any) => e.kind === "unauthenticated" && !/对方的话/.test(e.message));
    status = 404;
    await assert.rejects(peer.card("a1"), (e: any) => e.kind === "not_found");
    status = 429;
    await assert.rejects(peer.getTask(c, "t1"), (e: any) => e.kind === "busy" && e.more.retryAfterS === 7 && e.more.reason === "RESOURCE_EXHAUSTED" && e.more.remoteMessage === "对方的话");
    // A refused address is "refused" (never retried), an offline one "unreachable".
    const bad = new A2APeer({ root: s.url, kind: "direct", token: async () => "t" });
    await assert.rejects(bad.directory(), (e: any) => e.kind === "refused");
    const closed = createNet();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const port = (closed.address() as any).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const off = new A2APeer({ root: `http://127.0.0.1:${port}`, kind: "direct", policy: LOOPBACK_OK, token: async () => "t" });
    await assert.rejects(off.directory(), (e: any) => e.kind === "unreachable");
  } finally {
    await s.close();
    await other.close();
  }
});
