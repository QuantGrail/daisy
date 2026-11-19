/**
 * P1-03 (D-30, D-31, ADR-101, ADR-102): the two faces and their ports.
 * S-2 against the real start command; the outside face over real TLS.
 */
import { stopGracefully } from "./fixtures/stop-daisy.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { connect, createServer, Socket } from "node:net";
import { request as httpsRequest } from "node:https";
import { checkServerIdentity } from "node:tls";
import { networkInterfaces, tmpdir } from "node:os";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { createApp } from "../packages/daisy/src/app.ts";
import {
  bindPort,
  derivedPort,
  PORT_BASE,
  PORT_SPAN,
  portsFrom,
} from "../packages/daisy/src/access/ports.ts";
import { readAccessConfig } from "../packages/daisy/src/access/config.ts";
import { FACE, faceOf, privateAddress } from "../packages/daisy/src/access/faces.ts";
import { otherAccountsInDscl, otherAccountsInPasswd, otherUidRunning } from "../packages/daisy/src/access/shared-host.ts";
import { PIN_GRANT_HEADER } from "../packages/daisy/src/access/pin-seam.ts";
import { pinDouble } from "./fixtures/pin-double.ts";

const lanAddress = () =>
  Object.values(networkInterfaces())
    .flat()
    .find((i) => i && i.family === "IPv4" && !i.internal)?.address;

const tryConnect = (host: string, port: number) =>
  new Promise<string>((ok) => {
    const s = connect({ host, port });
    s.setTimeout(3000);
    s.once("connect", () => {
      s.destroy();
      ok("connected");
    });
    s.once("timeout", () => {
      s.destroy();
      ok("timeout");
    });
    s.once("error", (e: any) => ok(e.code || "error"));
  });

test("the preferred port comes from the uid (local 29200+, outside 29600+, 390 each)", () => {
  assert.equal(derivedPort("local", 1000), 29420);
  assert.equal(derivedPort("external", 1000), 29820);
  assert.equal(derivedPort("local", 501), 29311);
  assert.equal(derivedPort("external", 501), 29711);
  assert.equal(derivedPort("local", 0), 29200);
  assert.equal(derivedPort("local", 389), 29589);
  assert.equal(derivedPort("local", 390), 29200);
  // Two accounts on one host: different ports (unless their uids are ≡ mod 390).
  assert.notEqual(derivedPort("local", 1001), derivedPort("local", 1002));
  for (const uid of [0, 1, 501, 1000, 65533, 2 ** 31])
    for (const f of ["local", "external"] as const) {
      const p = derivedPort(f, uid);
      assert.ok(p >= PORT_BASE[f] && p < PORT_BASE[f] + PORT_SPAN);
    }
  // The search wraps inside the range and visits every port once.
  const all = [...portsFrom("local", 29589)];
  assert.equal(all[0], 29589);
  assert.equal(all[1], 29200);
  assert.equal(new Set(all).size, PORT_SPAN);
});

test("taken → the next free one, remembered on a first start; a given port is never switched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-ports-"));
  const taken = new Set<number>();
  const listen = async (port: number) => {
    if (taken.has(port)) throw Object.assign(Error("in use"), { code: "EADDRINUSE" });
  };
  try {
    const pref = derivedPort("local", 1000);
    taken.add(pref);
    const first = await bindPort("local", { dataDir: dir, uid: 1000 }, listen);
    assert.equal(first.port, pref + 1);
    assert.equal(first.source, "moved");
    assert.equal(readAccessConfig(dir).ports.local, pref + 1);
    // Config file: the owner's only.
    if (process.platform !== "win32") assert.equal(statSync(join(dir, "config.json")).mode & 0o777, 0o600);
    taken.clear();
    const again = await bindPort("local", { dataDir: dir, uid: 1000 }, listen);
    assert.deepEqual([again.port, again.source], [pref + 1, "remembered"]);
    // Remembered taken later: moved for this run, the remembered one kept.
    taken.add(pref + 1);
    const moved = await bindPort("local", { dataDir: dir, uid: 1000 }, listen);
    assert.deepEqual([moved.port, moved.source], [pref + 2, "moved"]);
    assert.equal(readAccessConfig(dir).ports.local, pref + 1);
    // Given: used as given; taken → refused with what to do.
    taken.add(4321);
    await assert.rejects(
      bindPort("local", { dataDir: dir, given: 4321 }, listen),
      /端口 4321 已被占用（这是指定的端口，不会悄悄换）/,
    );
    const given = await bindPort("local", { dataDir: dir, given: 4322 }, listen);
    assert.deepEqual([given.port, given.source], [4322, "given"]);
    // A first start of the outside face on a fresh directory: derived.
    const ext = await bindPort("external", { dataDir: dir, uid: 1000 }, listen);
    assert.deepEqual([ext.port, ext.source], [derivedPort("external", 1000), "derived"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S-2: the real start command listens on 127.0.0.1 only; another machine cannot connect; runtime file 0600", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-s2-"));
  const data = join(dir, "data");
  // Something already on the preferred port: the start moves on and says so.
  const blocker = createServer();
  const pref = derivedPort("local");
  await new Promise<void>((ok) => {
    blocker.once("error", () => ok());
    blocker.listen(pref, "127.0.0.1", () => ok());
  });
  const child = spawn(process.execPath, ["--import", "tsx", resolve("packages/daisy/src/main.ts")], {
    env: {
      ...process.env,
      DAISY_DATA: data,
      HARBOR_DATA: "",
      DAISY_PORT: "",
      PORT: "",
      HOST: "",
      DAISY_LOCAL_RUNNER: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (b) => (out += b));
  child.stderr.on("data", (b) => (out += b));
  try {
    const runtime = join(data, "runtime.json");
    for (let i = 0; i < 600 && !existsSync(runtime); i++) await sleep(100);
    assert.ok(existsSync(runtime), out);
    await sleep(200);
    if (process.platform !== "win32") assert.equal(statSync(runtime).mode & 0o777, 0o600);
    const rt = JSON.parse(readFileSync(runtime, "utf8"));
    assert.equal(rt.pid, child.pid);
    assert.match(rt.local.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(rt.external, null);
    assert.equal(rt.cliCredential, join(data, "keys", "cli-credential"));
    // No credential in the runtime file itself.
    const cli = readFileSync(rt.cliCredential, "utf8").trim();
    assert.ok(!readFileSync(runtime, "utf8").includes(cli));
    const port = rt.local.port;
    assert.ok(port >= 29200 && port < 29590, String(port));
    // The preferred port was taken — by the blocker, or (the blocker was
    // refused) by something else already: the next free one, said so,
    // remembered.
    assert.notEqual(port, pref);
    assert.equal(rt.local.source, "moved");
    assert.equal(readAccessConfig(data).ports.local, port);
    // Here: answers. Health is public; the rest needs the credential.
    assert.equal((await fetch(`${rt.local.url}/api/health`)).status, 200);
    assert.equal((await fetch(`${rt.local.url}/api/sessions`)).status, 401);
    assert.equal(
      (await fetch(`${rt.local.url}/api/sessions`, { headers: { authorization: `Bearer ${cli}` } })).status,
      200,
    );
    // From another machine (this machine's LAN address stands in): nothing listens.
    const lan = lanAddress();
    if (!lan) t.diagnostic("no non-loopback IPv4 address here: the LAN check is skipped");
    else assert.notEqual(await tryConnect(lan, port), "connected", `${lan}:${port} 连上了`);
    // Not on IPv6 / every address either.
    assert.notEqual(await tryConnect("::1", port), "connected");
    // No outside face by default.
    assert.equal(readAccessConfig(data).external.enabled, false);
  } finally {
    stopGracefully(child, data);
    await new Promise((ok) => child.once("exit", ok));
    blocker.close();
    assert.ok(!existsSync(join(data, "runtime.json")), "运行时文件在退出后应删除");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the outside face — off by default, PIN to turn on, TLS, outside sessions only, terminal / shell / browse off", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-ext-"));
  const pin = pinDouble();
  const ctx = await createApp({ pinGate: false,
    dataDir: dir,
    workspaceHome: dir,
    workspaceRoots: [dir],
    pin,
    sharedHost: () => false,
    peerIsOwner: () => true,
  });
  const cli = readFileSync(join(dir, "keys", "cli-credential"), "utf8").trim();
  const local = (o: any) => ctx.app.inject(o);
  const asCli = { authorization: `Bearer ${cli}` };
  try {
    // Off: no code for it, no listener.
    const noCode = await local({
      method: "POST",
      url: "/api/web/open-code/external",
      headers: { ...asCli, [PIN_GRANT_HEADER]: pin.grant("246810", "cli").grant },
    });
    assert.equal(noCode.statusCode, 409);
    // Turning it on wants the PIN.
    const on = (body: any, h: any = asCli) =>
      local({ method: "PUT", url: "/api/access/external", headers: h, payload: body });
    const refused = await on({ host: "127.0.0.1" });
    assert.equal(refused.statusCode, 403);
    assert.equal(refused.json().code, "pin_required");
    assert.equal(ctx.access.faces.externalListening, false);
    // Plain HTTP only on a private-network address.
    const g = () => ({ ...asCli, [PIN_GRANT_HEADER]: pin.grant("246810", "cli").grant });
    const plain = await on({ host: "8.8.8.8", tls: false }, g());
    assert.equal(plain.statusCode, 400);
    assert.equal(plain.json().code, "external_invalid");
    assert.equal(privateAddress("10.0.0.5"), true);
    assert.equal(privateAddress("100.101.102.103"), true);
    assert.equal(privateAddress("192.168.1.2"), true);
    assert.equal(privateAddress("172.32.0.1"), false);
    assert.equal(privateAddress("fd7a:115c:a1e0::1"), true);
    // A code-less local page session before: it stops counting once the
    // outside face is on (D-09: the passcode turns on).
    const codeless = (
      await local({ method: "POST", url: "/api/web/session", headers: { origin: "http://localhost:80" }, payload: {} })
    ).json().token;
    const st = (await on({ host: "127.0.0.1" }, g())).json();
    assert.equal(st.external.enabled, true);
    assert.equal(st.external.listening, true);
    assert.equal(st.passcode.effective, true);
    assert.equal((await local({ url: "/api/sessions", headers: { authorization: `Bearer ${codeless}` } })).statusCode, 401);
    const port = st.external.port;
    assert.ok(port >= 29600 && port < 29990);
    // TLS: a certificate for 127.0.0.1, key and certificate 0600.
    const ca = readFileSync(join(dir, "keys", "tls-cert.pem"), "utf8");
    if (process.platform !== "win32") assert.equal(statSync(join(dir, "keys", "tls-key.pem")).mode & 0o777, 0o600);
    if (process.platform !== "win32") assert.equal(statSync(join(dir, "keys", "tls-cert.pem")).mode & 0o777, 0o600);
    const ext = (path: string, o: { method?: string; headers?: any; body?: any } = {}) =>
      new Promise<{ status: number; json: any }>((ok, fail) => {
        const req = httpsRequest(
          { host: "127.0.0.1", port, path, method: o.method || "GET", headers: { ...(o.body ? { "content-type": "application/json" } : {}), ...o.headers }, ca,
            // A forged Host header must not change which certificate is checked.
            checkServerIdentity: (_h: string, cert: any) => checkServerIdentity("127.0.0.1", cert) },
          (res) => {
            let b = "";
            res.on("data", (c) => (b += c));
            res.on("end", () => ok({ status: res.statusCode!, json: b ? JSON.parse(b) : null }));
          },
        );
        req.on("error", fail);
        if (o.body) req.write(JSON.stringify(o.body));
        req.end();
      });
    assert.equal((await ext("/api/health")).status, 200);
    // Over the outside face: the command line's credential, a local web
    // session and an AI credential are nothing.
    assert.equal((await ext("/api/sessions", { headers: asCli })).status, 401);
    assert.equal((await ext("/api/sessions", { headers: { authorization: `Bearer ${ctx.issueToken("local")}` } })).status, 401);
    // No session without a code there, even with its own Origin.
    const ask = await ext("/api/web/session", { method: "POST", headers: { origin: `https://127.0.0.1:${port}` }, body: {} });
    assert.equal(ask.status, 401);
    // A local code is not an outside one.
    const localCode = (await local({ method: "POST", url: "/api/web/open-code", headers: asCli })).json().code;
    assert.equal((await ext("/api/web/session", { method: "POST", body: { code: localCode } })).status, 401);
    // The outside code (PIN): a session that works there and only there.
    const oc = await local({ method: "POST", url: "/api/web/open-code/external", headers: g() });
    assert.equal(oc.statusCode, 200);
    assert.match(oc.json().url, new RegExp(`^https://[^/]+:${port}/#code=`));
    const s = await ext("/api/web/session", { method: "POST", body: { code: oc.json().code } });
    assert.equal(s.status, 200);
    assert.equal(s.json.face, "external");
    const eh = { authorization: `Bearer ${s.json.token}` };
    assert.equal((await ext("/api/sessions", { headers: eh })).status, 200);
    assert.deepEqual((await ext("/api/me", { headers: eh })).json.face, "external");
    assert.equal((await local({ url: "/api/sessions", headers: eh })).statusCode, 401);
    // Another origin / another Host on the outside face: refused.
    assert.equal((await ext("/api/sessions", { headers: { ...eh, origin: "https://evil.example" } })).status, 403);
    assert.equal((await ext("/api/sessions", { headers: { ...eh, origin: `http://127.0.0.1:${port}` } })).status, 403);
    assert.equal((await ext("/api/sessions", { headers: { ...eh, host: `evil.example:${port}` } })).status, 403);
    assert.equal((await ext("/api/sessions", { headers: { ...eh, origin: `https://127.0.0.1:${port}` } })).status, 200);
    // Terminal, shell, browse: off on the outside face, on locally.
    for (const [method, path] of [
      ["POST", "/api/sessions/x/shell"],
      ["GET", "/api/shell/x"],
      ["GET", "/api/sessions/x/terminal"],
      ["GET", "/api/sessions/x/terminal/j/output?after=0"],
      ["POST", "/api/sessions/x/terminal/j/input"],
      // Review M-1: opening a terminal, and harness configuration that
      // writes commands (mcp.add, hooks via config.write).
      ["POST", "/api/sessions/x/operations/terminal"],
      ["POST", "/api/sessions/x/operations/harness"],
      ["POST", "/api/nodes/x/filesystem"],
      ["GET", "/api/filesystem/x"],
    ]) {
      const r = await ext(path, { method, headers: eh, ...(method === "POST" ? { body: {} } : {}) });
      assert.equal(r.status, 403, path);
      assert.equal(r.json.code, "external_off", path);
      const l = await local({ method, url: path, headers: { authorization: `Bearer ${ctx.issueToken()}` }, ...(method === "POST" ? { payload: {} } : {}) });
      assert.notEqual(l.json()?.code, "external_off");
    }
    // The owner turns the shell on (PIN): it is through the guard there.
    const shellOn = (await on({ host: "127.0.0.1", allow: { shell: true } }, g())).json();
    assert.equal(shellOn.external.allow.shell, true);
    const port2 = shellOn.external.port;
    assert.equal(port2, port, "记住的端口");
    // The live socket from another origin: refused at the upgrade.
    const wsRefused = await new Promise<string>((ok) => {
      const w = new WebSocket(`wss://127.0.0.1:${port}/api/live`, { ca, headers: { origin: "https://evil.example" } });
      w.on("open", () => {
        w.terminate();
        ok("open");
      });
      w.on("unexpected-response", (q, res) => {
        q.destroy();
        ok(String(res.statusCode));
      });
      w.on("error", () => ok("error"));
    });
    assert.equal(wsRefused, "403");
    // Off: the listener closes, outside sessions end.
    const off = await local({ method: "DELETE", url: "/api/access/external", headers: asCli });
    assert.equal(off.statusCode, 200);
    assert.equal(off.json().external.listening, false);
    assert.notEqual(await tryConnect("127.0.0.1", port), "connected");
    assert.equal(ctx.access.web.find(s.json.token), undefined);
    // Review L-1: a bad setting (hand-edited config.json) never listens.
    await assert.rejects(
      ctx.access.faces.startExternal({ enabled: true, host: "8.8.8.8", tls: false, allow: { terminal: false, shell: false, browse: false } }),
      /明文 HTTP 只允许/,
    );
    assert.equal(ctx.access.faces.externalListening, false);
    // Audited.
    const actions = ctx.store.all("SELECT action FROM audit").map((r) => r.action);
    assert.ok(actions.includes("access.external.on") && actions.includes("access.external.off"));
  } finally {
    await ctx.app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the live socket: Origin checked at the upgrade; the first frame's credential gets the same rules", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-ws-"));
  const ctx = await createApp({ pinGate: false, dataDir: dir, workspaceHome: dir, sharedHost: () => false });
  try {
    await ctx.app.listen({ host: "127.0.0.1", port: 0 });
    const port = (ctx.app.server.address() as any).port;
    const cli = readFileSync(join(dir, "keys", "cli-credential"), "utf8").trim();
    const h = { authorization: `Bearer ${cli}` };
    const cat = (await ctx.app.inject({ url: "/api/catalog", headers: h })).json();
    const s = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: h,
        payload: { agent: "claude", workspaceId: cat.workspaces[0].id, profileId: cat.profiles[0].id },
      })
    ).json();
    const open = (headers: any, token?: string) =>
      new Promise<string>((resolveOpen) => {
        const w = new WebSocket(`ws://127.0.0.1:${port}/api/live`, { headers });
        let done = false;
        const ok = (v: string) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          w.terminate();
          resolveOpen(v);
        };
        const timer = setTimeout(() => ok("timeout"), 8000);
        w.on("unexpected-response", (q, res) => {
          q.destroy();
          ok("http " + res.statusCode);
        });
        w.on("open", () => w.send(JSON.stringify({ type: "subscribe", sessionId: s.id, ...(token ? { token } : {}) })));
        w.on("message", (m) => {
          if (JSON.parse(String(m)).type === "ready") ok("ready");
        });
        w.on("close", (code) => ok("close " + code));
        w.on("error", () => ok("error"));
      });
    assert.equal(await open({ origin: "http://evil.example" }, cli), "http 403");
    assert.equal(await open({}, "dcli_not-the-credential-0000000000000000000000"), "close 1008");
    assert.equal(await open({}), "close 1008");
    assert.equal(await open({ origin: `http://127.0.0.1:${port}` }, ctx.issueToken()), "ready");
    assert.equal(await open({}, cli), "ready");
  } finally {
    await ctx.app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review L-2: an untagged real socket is the outside face; only in-process requests are local", () => {
  assert.equal(faceOf({ raw: { socket: new Socket() } }), "external");
  assert.equal(faceOf({ raw: { socket: {} } }), "local");
  const tagged = new Socket();
  (tagged as any)[FACE] = "local";
  assert.equal(faceOf({ raw: { socket: tagged } }), "local");
});

test("W-2: a shared machine is told apart from a personal one (and anything unclear counts as shared)", () => {
  const passwd = [
    "root:x:0:0:root:/root:/bin/bash",
    "daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin",
    "nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin",
    "me:x:1000:1000::/home/me:/bin/bash",
    "svc:x:1001:1001::/srv:/bin/false",
  ].join("\n");
  assert.deepEqual(otherAccountsInPasswd(passwd, 1000, 1000), []);
  assert.deepEqual(otherAccountsInPasswd(passwd + "\nalice:x:1002:1002::/home/alice:/bin/zsh", 1000, 1000), ["alice"]);
  const dscl = "_www 70\nnobody -2\nme 501\n_spotlight 89\n";
  assert.deepEqual(otherAccountsInDscl(dscl, 501), []);
  assert.deepEqual(otherAccountsInDscl(dscl + "kid 502\n", 501), ["kid"]);
  // P5-04: macOS also looks at who runs processes now (a directory account dscl . does not list).
  assert.equal(otherUidRunning("    0\n   89\n  501\n   -2\n  501\n", 501), false);
  assert.equal(otherUidRunning("    0\n  501\n 1027\n", 501), true);
});
