/**
 * P5-03 (ADR-142, 7.6 「配对」, 5.11 「配对新设备、吊销设备」, W-3): pairing
 * the owner's other devices — refused first.
 *
 * A real Daisy with its outside face listening (plain HTTP on loopback) is
 * the phone's way in: the "phone" is this test process with real fetch and
 * a real WebSocket against that face. The owner works on the local face
 * (app.inject: the web page, the command line).
 *
 * Refused: making a code without the PIN, by the AI's working credential,
 * by a visitor; a code while the outside face is off; trading a code on the
 * local face, a wrong one, an expired one, a used one, one made before the
 * PIN changed; guessing (the lock, which voids every unused code); a device
 * credential on the wrong face, revoked, idle too long; a device without
 * the PIN on what wants it. Revoking is at once: the next request, an open
 * live socket, a long poll in flight. A PIN reset revokes every device.
 * Never a code or a credential in the audit.
 *
 * W-3 itself is a real phone (真机); this is its automated stand-in: the
 * phone pairs, sees the sessions, answers a card, and is cut off when the
 * owner revokes it in settings.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../packages/daisy/src/app.ts";
import WebSocketNode from "ws";
import { daisy, runningTurn, OTHER_SUB } from "./fixtures/daisy-with-issuer.ts";
import { PIN_GRANT_HEADER } from "../packages/daisy/src/access/pin-seam.ts";
import { runnerHeaders } from "./fixtures/runner-calls.ts";
import { DEVICE_LIMITS } from "../packages/contracts/src/limits.ts";
import { normalizePairingCode, newPairingCode } from "../packages/daisy/src/access/devices.ts";
import { API_ROUTES, fillPath, pinFor } from "../packages/contracts/src/index.ts";
import { PassThrough } from "node:stream";
import { redact } from "../packages/daisy/src/observe/redact.ts";
import { serve } from "../packages/daisy/src/app/serve.ts";
import { binary, exempt, group, route } from "../packages/contracts/src/api/route.ts";
import { parsePairedDevice } from "../packages/ui/src/device-store.ts";
import { LIVE_CLOSE } from "../packages/contracts/src/live.ts";

const PIN = "246810";
const webHolder = (token: string) => `web:${createHash("sha256").update(token).digest("hex")}`;

/** A Daisy whose outside face listens on loopback (plain HTTP): the phone's way in. */
async function setup(o: { before?: (app: any) => void } = {}) {
  const d = await daisy();
  o.before?.(d.ctx.app);
  const on = await d.ctx.app.inject({
    method: "PUT",
    url: "/api/access/external",
    headers: d.withPin(),
    payload: { host: "127.0.0.1", tls: false },
  });
  assert.equal(on.statusCode, 200, on.body);
  const ext = `http://127.0.0.1:${on.json().external.port}`;
  const webToken = d.ctx.issueToken();
  const web = { authorization: `Bearer ${webToken}` };
  const webPin = () => ({ ...web, [PIN_GRANT_HEADER]: d.pin.grant(PIN, webHolder(webToken)).grant });
  /** The owner makes a code (the web page, with the PIN). */
  const pair = async (name?: string) => {
    const r = await d.ctx.app.inject({ method: "POST", url: "/api/devices/pair", headers: webPin(), payload: name ? { name } : {} });
    assert.equal(r.statusCode, 200, r.body);
    return r.json() as { code: string; url: string; expiresAt: number; name: string | null };
  };
  /** The phone: real HTTP to the outside face. */
  const phone = async (method: string, path: string, o: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const r = await fetch(ext + path, {
      method,
      headers: {
        ...(o.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
        ...o.headers,
      },
      ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
    });
    const text = await r.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: r.status, json, text, headers: r.headers };
  };
  const redeem = (code: string, name?: string) => phone("POST", "/api/devices/redeem", { body: { code, ...(name ? { name } : {}) } });
  /** Pair a phone all the way: its credential and first session. */
  const paired = async (name = "我的手机") => {
    const c = await pair();
    const r = await redeem(c.code, name);
    assert.equal(r.status, 200, r.text);
    return r.json as { deviceId: string; token: string; secret: string; expiresAt: number; face: string; name: string };
  };
  const devices = (state = "all") =>
    d.ctx.app.inject({ url: `/api/devices?state=${state}`, headers: web }).then((r) => r.json().devices as any[]);
  const revoke = (id: string) => d.ctx.app.inject({ method: "DELETE", url: `/api/devices/${id}`, headers: webPin() });
  /** Move the device store's clock (codes run out, devices idle). */
  const later = (ms: number) => {
    (d.ctx.access.devices as any).now = () => Date.now() + ms;
  };
  return { d, ext, web, webToken, webPin, pair, phone, redeem, paired, devices, revoke, later };
}

test("pairing codes: refused without the PIN, to the AI, to a visitor, while the outside face is off", async () => {
  const d = await daisy();
  try {
    await d.configure();
    const t = await runningTurn(d);
    const web = { authorization: `Bearer ${d.ctx.issueToken()}` };
    const pair = (headers: Record<string, string>) => d.ctx.app.inject({ method: "POST", url: "/api/devices/pair", headers, payload: {} });
    // No PIN: the command line, the web page.
    for (const h of [d.asCli, web]) {
      const r = await pair(h);
      assert.equal(r.statusCode, 403);
      assert.equal(r.json().code, "pin_required");
    }
    // The AI's working credential: never, with a grant bound to it either.
    for (const h of [{}, { [PIN_GRANT_HEADER]: d.pin.grant(PIN, "ai").grant }] as Record<string, string>[]) {
      const r = await pair({ authorization: `Bearer ${t.ai}`, ...h });
      assert.equal(r.statusCode, 403);
      assert.equal(r.json().code, "channel_not_allowed");
      for (const [method, url] of [["GET", "/api/devices"], ["DELETE", "/api/devices/dev_x"]] as const) {
        const x = await d.ctx.app.inject({ method, url, headers: { authorization: `Bearer ${t.ai}`, ...h } });
        assert.equal(x.json().code, "channel_not_allowed", `${method} ${url}`);
      }
    }
    // A visitor (the issuer's token for someone else; the owner's held by an AI).
    for (const tok of [await d.tokenFor(OTHER_SUB), await d.tokenFor("user:zz-owner", { act: { sub: "agent:a1" } })]) {
      const r = await pair({ authorization: `Bearer ${tok}` });
      assert.equal(r.statusCode, 403);
      assert.equal(r.json().code, "a2a_only");
    }
    // With the PIN, but the outside face is off: no code (it could not be used).
    const off = await pair(d.withPin());
    assert.equal(off.statusCode, 409);
    assert.equal(off.json().code, "external_off");
    assert.equal(d.ctx.access.devices.pendingCodes(), 0);
    // The command line's grant was used up by that request.
  } finally {
    await d.close();
  }
});

test("redeeming: the local face, a wrong code, an expired one, a used one, one from before the PIN changed — all refused", async () => {
  const s = await setup();
  const { d, pair, redeem, later } = s;
  try {
    const c = await pair();
    assert.match(c.code, /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    assert.ok(c.url.startsWith(s.ext + "/#pair="), c.url);
    assert.ok(c.expiresAt - Date.now() <= DEVICE_LIMITS.pairCodeTtlMs);
    // On the local face (this machine's page): refused, and the code is not used up.
    const local = await d.ctx.app.inject({ method: "POST", url: "/api/devices/redeem", payload: { code: c.code } });
    assert.equal(local.statusCode, 403);
    assert.equal(local.json().code, "device_face");
    // A wrong code.
    const wrong = await redeem(newPairingCode());
    assert.equal(wrong.status, 401);
    assert.equal(wrong.json.code, "code_invalid");
    // Expired (the clock moved past its five minutes).
    later(DEVICE_LIMITS.pairCodeTtlMs + 1000);
    const expired = await redeem(c.code);
    assert.equal(expired.status, 401);
    assert.equal(expired.json.code, "code_invalid");
    later(0);
    // Used once: the second time is refused (typed differently, same code).
    const c2 = await pair();
    const ok = await redeem(c2.code.toLowerCase().replace("-", " "));
    assert.equal(ok.status, 200, ok.text);
    const again = await redeem(c2.code);
    assert.equal(again.status, 401);
    assert.equal(again.json.code, "code_invalid");
    // Made before the PIN changed: void.
    const c3 = await pair();
    d.pin.set("135799", PIN);
    const stale = await redeem(c3.code);
    assert.equal(stale.status, 401);
    assert.equal(stale.json.code, "code_invalid");
    // Never a code in the audit or its error answers.
    const audit = JSON.stringify(d.ctx.store.all("SELECT * FROM audit"));
    for (const x of [c.code, c2.code, c3.code, normalizePairingCode(c.code)!]) assert.ok(!audit.includes(x), "审计里有配对码");
    assert.ok(audit.includes("device.pair.code") && audit.includes("device.paired"));
  } finally {
    await d.close();
  }
});

test("guessing: five wrong codes from one source lock that source (review L-2: per source, the code is not voided for the others); per-address rate limit", async () => {
  const s = await setup();
  const { d, pair, redeem, later } = s;
  try {
    const good = await pair();
    for (let i = 1; i <= DEVICE_LIMITS.redeemFailuresMax; i++) {
      const r = await redeem(newPairingCode());
      assert.equal(r.status, 401, `第 ${i} 次`);
    }
    // Locked: even the right code is refused from this source (423, Retry-After) — and not used up.
    const locked = await redeem(good.code);
    assert.equal(locked.status, 423);
    assert.equal(locked.json.code, "pair_locked");
    assert.ok(Number(locked.headers.get("retry-after")) > 0);
    assert.equal(d.ctx.access.devices.pendingCodes(), 1);
    // Another source pairs with it (straight at the store: this test's callers all share 127.0.0.1).
    assert.equal(d.ctx.access.devices.redeem(good.code, { face: "external", bucket: "external:ip:192.0.2.9" }).device.state, "active");
    // After the lock: this source may try again (the code has run out by now).
    later(DEVICE_LIMITS.redeemLockMs + 1000);
    const after = await redeem(good.code);
    assert.equal(after.status, 401);
    const audit = JSON.stringify(d.ctx.store.all("SELECT action FROM audit"));
    assert.ok(audit.includes("device.pair.locked"));
    // Per address: at most DEVICE_LIMITS.redeemPerMinute a minute.
    let limited = false;
    for (let i = 0; i < DEVICE_LIMITS.redeemPerMinute + 1 && !limited; i++)
      limited = (await redeem(newPairingCode())).status === 429;
    assert.ok(limited, "每个地址每分钟有上限");
  } finally {
    await d.close();
  }
});

test("W-3 stand-in: a phone pairs over the outside face, sees the sessions, answers a card; its session is a device's (channel device)", async () => {
  const s = await setup();
  const { d, phone, paired, devices } = s;
  try {
    const t = await runningTurn(d);
    const p = await paired("我的 iPhone‮伪装");
    assert.equal(p.face, "external");
    assert.match(p.secret, /^ddev_/);
    assert.match(p.token, /^dweb_/);
    assert.ok(p.expiresAt - Date.now() <= DEVICE_LIMITS.sessionTtlMs);
    assert.equal(p.name, "我的 iPhone 伪装", "名字里的控制字符和方向符被去掉");
    const me = await phone("GET", "/api/me", { token: p.token });
    assert.equal(me.status, 200, me.text);
    assert.equal(me.json.channel, "device");
    assert.equal(me.json.face, "external");
    assert.equal(me.json.deviceId, p.deviceId);
    // The sessions.
    const list = await phone("GET", "/api/sessions", { token: p.token });
    assert.equal(list.status, 200, list.text);
    assert.ok(JSON.stringify(list.json).includes(t.own));
    // A card: the AI asks for a tool approval; the phone answers it.
    const nodeId = JSON.parse(readFileSync(join(d.dir, "runner.json"), "utf8")).nodeId;
    const ev = await d.inject({
      method: "POST",
      url: `/api/runner/jobs/${t.job.id}/events`,
      headers: { ...runnerHeaders(nodeId), "x-lease": t.job.lease },
      payload: {
        events: [
          {
            id: "evt-perm-p503",
            type: "approval",
            data: { id: "perm-p503", title: "Bash", input: { command: "ls" }, options: [{ id: "allow", label: "允许本次" }, { id: "deny", label: "拒绝" }], category: "permission" },
          },
        ],
      },
    });
    assert.equal(ev.statusCode, 200, ev.body);
    const cards = await phone("GET", "/api/approvals?status=pending", { token: p.token });
    assert.ok(cards.json.items.some((x: any) => x.id === "perm:perm-p503"), cards.text);
    const answer = await phone("POST", "/api/approvals/perm:perm-p503/respond", { token: p.token, body: { decision: "allow" } });
    assert.equal(answer.status, 200, answer.text);
    // The list: the device, and it knows which one asked.
    const mine = await phone("GET", "/api/devices", { token: p.token });
    assert.equal(mine.status, 200, mine.text);
    const row = mine.json.devices.find((x: any) => x.id === p.deviceId);
    assert.equal(row.current, true);
    assert.equal(row.state, "active");
    assert.ok(!JSON.stringify(mine.json).includes(p.secret));
    assert.equal((await devices("active")).length, 1);
    // A new session from the credential (what the page does when one runs out).
    const fresh = await phone("POST", "/api/devices/session", { body: { secret: p.secret } });
    assert.equal(fresh.status, 200, fresh.text);
    assert.equal(fresh.json.deviceId, p.deviceId);
    assert.notEqual(fresh.json.token, p.token);
    assert.equal((await phone("GET", "/api/me", { token: fresh.json.token })).status, 200);
    // The device credential is no Bearer, and not good on the local face.
    assert.equal((await phone("GET", "/api/me", { token: p.secret })).status, 401);
    const local = await d.ctx.app.inject({ method: "POST", url: "/api/devices/session", payload: { secret: p.secret } });
    assert.equal(local.json().code, "device_face");
    // The device session is not good on the local face either.
    assert.equal((await d.ctx.app.inject({ url: "/api/me", headers: { authorization: `Bearer ${p.token}` } })).statusCode, 401);
    // Never a credential, a session or a code in the audit.
    const audit = JSON.stringify(d.ctx.store.all("SELECT * FROM audit"));
    for (const x of [p.secret, p.token, fresh.json.token]) assert.ok(!audit.includes(x), "审计里有凭据");
  } finally {
    await d.close();
  }
});

test("revoking a device is at once: the next request, its open live socket, a long poll in flight, its credential — others unaffected", async () => {
  const s = await setup();
  const { d, ext, phone, paired, revoke } = s;
  try {
    const t = await runningTurn(d);
    const a = await paired("A");
    const b = await paired("B");
    // A's live socket on the outside face.
    const ws = new WebSocketNode(ext.replace(/^http/, "ws") + "/api/live");
    const frames: any[] = [];
    let closed: { code: number; reason: string } | null = null;
    ws.on("message", (m) => frames.push(JSON.parse(String(m))));
    ws.on("close", (code, reason) => (closed = { code, reason: String(reason) }));
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ type: "subscribe", token: a.token, sessionId: t.own }));
    const until = async (ok: () => boolean, what: string, ms = 5000) => {
      const end = Date.now() + ms;
      while (!ok()) {
        if (Date.now() > end) assert.fail(`没等到：${what}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    await until(() => frames.some((f) => f.type === "ready"), "实时通道 ready");
    // A long poll of A, in flight (no event to answer it for up to 10 s).
    const t0 = Date.now();
    const poll = phone("GET", "/api/events?after=0&wait=10", { token: a.token });
    await new Promise((r) => setTimeout(r, 300));
    // Refused first: without the PIN, nothing is revoked.
    const noPin = await d.ctx.app.inject({ method: "DELETE", url: `/api/devices/${a.deviceId}`, headers: s.web });
    assert.equal(noPin.json().code, "pin_required");
    assert.equal((await phone("GET", "/api/me", { token: a.token })).status, 200);
    // The owner revokes A (settings, PIN).
    const r = await revoke(a.deviceId);
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().revoked.state, "revoked");
    assert.equal(r.json().revoked.revokedWhy, "owner");
    // The socket closes now — no change in the conversation needed.
    await until(() => closed !== null, "实时通道被关掉", 2000);
    // P6-26: with the revocation's own code (the page reacts on the close itself).
    assert.equal(closed!.code, LIVE_CLOSE.deviceRevoked);
    assert.equal(closed!.reason, "Device revoked");
    // The long poll is answered 401, not with data — and well before its 10 s.
    const pr = await poll;
    assert.equal(pr.status, 401, pr.text);
    assert.match(String(pr.headers.get("www-authenticate")), /invalid_token/);
    assert.ok(Date.now() - t0 < 9000, "长轮询没有等满");
    // The next request, and the credential.
    const next = await phone("GET", "/api/sessions", { token: a.token });
    assert.equal(next.status, 401);
    const ex = await phone("POST", "/api/devices/session", { body: { secret: a.secret } });
    assert.equal(ex.status, 401);
    assert.equal(ex.json.code, "device_invalid");
    // A new socket with A's session: refused.
    const ws2 = new WebSocketNode(ext.replace(/^http/, "ws") + "/api/live");
    let closed2: number | null = null;
    ws2.on("close", (code) => (closed2 = code));
    await new Promise((r) => ws2.once("open", r));
    ws2.send(JSON.stringify({ type: "subscribe", token: a.token, sessionId: t.own }));
    await until(() => closed2 !== null, "新的实时通道被拒");
    assert.equal(closed2, 1008);
    // B is untouched.
    assert.equal((await phone("GET", "/api/sessions", { token: b.token })).status, 200);
    // Revoking again answers the record as it is; an unknown id is 404.
    assert.equal((await revoke(a.deviceId)).json().revoked.state, "revoked");
    const none = await revoke("dev_nonexistent");
    assert.equal(none.statusCode, 404);
    assert.equal(none.json().code, "device_not_found");
    ws.close();
    ws2.close();
  } finally {
    await d.close();
  }
});

test("a device unpairs itself (no PIN; only a device may); a device idle too long is expired", async () => {
  const s = await setup();
  const { d, phone, paired, devices, later } = s;
  try {
    const a = await paired("A");
    // The web page has no device to forget.
    const w = await d.ctx.app.inject({ method: "DELETE", url: "/api/devices/self", headers: s.web });
    assert.equal(w.statusCode, 403);
    assert.equal(w.json().code, "channel_not_allowed");
    const f = await phone("DELETE", "/api/devices/self", { token: a.token });
    assert.equal(f.status, 200, f.text);
    assert.equal(f.json.revoked.revokedWhy, "self");
    assert.equal((await phone("GET", "/api/me", { token: a.token })).status, 401);
    assert.equal((await phone("POST", "/api/devices/session", { body: { secret: a.secret } })).status, 401);
    // Idle: a device not used for DEVICE_LIMITS.idleExpiryMs cannot trade its credential.
    const b = await paired("B");
    later(DEVICE_LIMITS.idleExpiryMs + 60_000);
    const ex = await phone("POST", "/api/devices/session", { body: { secret: b.secret } });
    assert.equal(ex.status, 401);
    assert.equal(ex.json.code, "device_invalid");
    assert.equal((await devices("all")).find((x) => x.id === b.deviceId).state, "expired");
    later(0);
  } finally {
    await d.close();
  }
});

test("a device is the owner in person, but the PIN is still the PIN: what wants it is refused without it, through with it", async () => {
  const s = await setup();
  const { d, phone, paired } = s;
  try {
    const a = await paired();
    // Every route that asks a paired device for the PIN.
    const gated = API_ROUTES.filter((r) => pinFor(r, "device") && r.output.kind !== "websocket");
    assert.ok(gated.length >= 20, `${gated.length}`);
    for (const r of gated) {
      const path = fillPath(r.path, Object.fromEntries(Object.keys(r.params.shape).map((k) => [k, "x-placeholder"])));
      const res = await phone(r.method, path, { token: a.token, ...(r.method === "GET" ? {} : { body: {} }) });
      assert.equal(res.status, 403, `${r.id}: ${res.text}`);
      assert.equal(res.json?.code, "pin_required", r.id);
    }
    // D-40 ①: the 「调用授权」 reads take no PIN on a device.
    assert.equal((await phone("GET", "/api/contacts", { token: a.token })).status, 200);
    // With a PIN grant bound to the device's own session: through (a second device is paired from the phone).
    const g = d.pin.grant(PIN, webHolder(a.token)).grant;
    const c = await phone("POST", "/api/devices/pair", { token: a.token, body: { name: "平板" }, headers: { [PIN_GRANT_HEADER]: g } });
    assert.equal(c.status, 200, c.text);
    assert.equal(c.json.name, "平板");
    // The web page's grant is not the device's.
    const webGrant = d.pin.grant(PIN, webHolder(s.webToken)).grant;
    const other = await phone("POST", "/api/devices/pair", { token: a.token, body: {}, headers: { [PIN_GRANT_HEADER]: webGrant } });
    assert.equal(other.json.code, "pin_required");
    // The audit names the device as who made the code.
    const row = d.ctx.store.one("SELECT user_id FROM audit WHERE action='device.pair.code' ORDER BY created DESC LIMIT 1");
    assert.equal(row.user_id, `device:${a.deviceId}`);
  } finally {
    await d.close();
  }
});

test("T-9: resetting the PIN revokes every device — records, sessions, credentials, unused codes (the real PIN service)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-p503-t9-"));
  // createApp's own PinService (scrypt, its reset runs every revocation hook in one transaction).
  const ctx = await createApp({ pinGate: false, dataDir: dir, workspaceHome: dir, workspaceRoots: [dir], sharedHost: () => false, peerIsOwner: () => true });
  try {
    const cli = { authorization: `Bearer ${readFileSync(join(dir, "keys", "cli-credential"), "utf8").trim()}` };
    const webToken = ctx.issueToken();
    const web = { authorization: `Bearer ${webToken}` };
    assert.equal((await ctx.app.inject({ method: "POST", url: "/api/pin", headers: cli, payload: { pin: PIN } })).statusCode, 200);
    const grant = async (h: Record<string, string>) =>
      (await ctx.app.inject({ method: "POST", url: "/api/pin/grant", headers: h, payload: { pin: PIN } })).json().grant as string;
    const externalOn = async () => {
      const on = await ctx.app.inject({ method: "PUT", url: "/api/access/external", headers: { ...cli, [PIN_GRANT_HEADER]: await grant(cli) }, payload: { host: "127.0.0.1", tls: false } });
      assert.equal(on.statusCode, 200, on.body);
      return `http://127.0.0.1:${on.json().external.port}`;
    };
    const post = (base: string, path: string, body: unknown, token?: string) =>
      fetch(base + path, {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
      });
    const ext = await externalOn();
    const wg = await grant(web);
    const code = async () => {
      const r = await ctx.app.inject({ method: "POST", url: "/api/devices/pair", headers: { ...web, [PIN_GRANT_HEADER]: wg }, payload: {} });
      assert.equal(r.statusCode, 200, r.body);
      return r.json().code as string;
    };
    const a = await (await post(ext, "/api/devices/redeem", { code: await code() })).json();
    const b = await (await post(ext, "/api/devices/redeem", { code: await code() })).json();
    const pending = await code();
    assert.equal(ctx.access.devices.pendingCodes(), 1);
    assert.equal((await fetch(ext + "/api/me", { headers: { authorization: `Bearer ${a.token}` } })).status, 200);
    // The web page cannot reset the PIN; the command line on this machine can.
    assert.equal((await ctx.app.inject({ method: "POST", url: "/api/pin/reset", headers: web, payload: { confirm: true } })).json().code, "channel_not_allowed");
    const reset = await ctx.app.inject({ method: "POST", url: "/api/pin/reset", headers: cli, payload: { confirm: true } });
    assert.equal(reset.statusCode, 200, reset.body);
    const summary = JSON.parse(ctx.store.one("SELECT target FROM audit WHERE action='pin.reset.revoke'").target);
    assert.equal(summary.revoked.devices, 2);
    assert.deepEqual(summary.pending, []);
    assert.equal(ctx.access.devices.pendingCodes(), 0);
    for (const x of ctx.access.devices.list("all")) {
      assert.equal(x.state, "revoked");
      assert.equal(x.revokedWhy, "pin_reset");
    }
    // The owner sets a PIN again on this machine and reopens the outside face: nothing comes back.
    assert.equal((await ctx.app.inject({ method: "POST", url: "/api/pin", headers: cli, payload: { pin: PIN } })).statusCode, 200);
    const ext2 = await externalOn();
    for (const p of [a, b]) {
      assert.equal((await fetch(ext2 + "/api/me", { headers: { authorization: `Bearer ${p.token}` } })).status, 401);
      assert.equal((await post(ext2, "/api/devices/session", { secret: p.secret })).status, 401);
    }
    assert.equal((await post(ext2, "/api/devices/redeem", { code: pending })).status, 401);
  } finally {
    await ctx.app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pairing codes: the alphabet, the normal form", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const c = newPairingCode();
    assert.match(c, /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    seen.add(c);
  }
  assert.equal(seen.size, 200);
  assert.equal(normalizePairingCode("ab0de-fg1hk"), "AB0DEFG1HK");
  assert.equal(normalizePairingCode(" abOde fgIhk "), "AB0DEFG1HK");
  assert.equal(normalizePairingCode("abLde-fghjk"), "AB1DEFGHJK");
  assert.equal(normalizePairingCode("ABCDE-FGHJ"), null);
  assert.equal(normalizePairingCode("ABCDE-FGHJU"), null, "U 不在字母表里");
});

// ── security review (P5-03) ──────────────────────────────────────────────

test("review M-1: what an anonymous caller sends to redeem / session is not taken for a secret (no redaction poisoning, no eviction) — only a code or credential that matched", async () => {
  const s = await setup();
  const { d, redeem, phone, paired, pair } = s;
  try {
    // Words that are everywhere in the audit; unauthenticated input must not mask them.
    const r1 = await redeem("external-face");
    assert.equal(r1.status, 401);
    const r2 = await phone("POST", "/api/devices/session", { body: { secret: "settings.pairRedeem-xyz" } });
    assert.equal(r2.status, 401);
    const r3 = await phone("POST", "/api/devices/session", { body: { secret: "ddev_not-a-credential-of-anyone-here" } });
    assert.equal(r3.status, 401);
    assert.equal(redact("external-face"), "external-face");
    assert.equal(redact("settings.pairRedeem-xyz"), "settings.pairRedeem-xyz");
    // While locked too.
    for (let i = 0; i < DEVICE_LIMITS.redeemFailuresMax; i++) await redeem(newPairingCode());
    const locked = await redeem("anonymous-word");
    assert.equal(locked.status, 423);
    assert.equal(redact("anonymous-word"), "anonymous-word");
    const row = d.ctx.store.one("SELECT target FROM audit WHERE action='access.denied' ORDER BY rowid DESC LIMIT 1");
    assert.match(row.target, /"face":"external"/, "审计里的面没有被抹掉");
    // A code that matched: its typed spelling is masked from then on; the credential too.
    d.ctx.access.devices.dropEverything();
    const c = await pair();
    const typed = c.code.toLowerCase().replace("-", " ");
    const ok = await redeem(typed);
    assert.equal(ok.status, 200, ok.text);
    assert.ok(redact(`x ${typed} y`).includes("[redacted]"));
    void paired;
    // Request bodies are never logged (the logger is off; nothing but redaction stands between a body and a log line otherwise).
    assert.match(readFileSync("packages/daisy/src/app.ts", "utf8"), /\blogger: false\b/, "Fastify 不记请求（也就不记请求体）");
  } finally {
    await d.close();
  }
});

test("review M-2: a paired device keeps the address of the Daisy it paired with; a record without one is not used", () => {
  const ok = parsePairedDevice(JSON.stringify({ id: "dev_a", secret: "ddev_x", name: "手机", url: "https://10.0.0.2:29600" }));
  assert.equal(ok?.url, "https://10.0.0.2:29600");
  assert.equal(parsePairedDevice(JSON.stringify({ id: "dev_a", secret: "ddev_x", name: "手机" })), null, "没有地址的旧记录不用");
  assert.equal(parsePairedDevice(JSON.stringify({ id: "dev_a", secret: "ddev_x", name: "手机", url: "javascript:alert(1)" })), null);
  assert.equal(parsePairedDevice("not json"), null);
  // The app trades the credential only with that address (P6-26: the device's
  // connection moved to packages/ui/src/device-session.ts; behaviour pinned in
  // tests/device-revoke-live.test.ts, "the credential goes only to device.url").
  const app = readFileSync("apps/app/App.tsx", "utf8");
  assert.ok(!/deviceClient\((url|c\.baseUrl),/.test(app), "启动时不能拿构建时的默认地址去换");
  const dev = readFileSync("packages/ui/src/device-session.ts", "utf8");
  assert.match(dev, /new DaisyClient\(device\.url, token,/);
  assert.match(dev, /new DaisyClient\(device\.url, "", transport\)\.deviceSession\(device\.secret\)/);
});

test("review L-1: redeem and session are refused from an allowed external-interface origin (no CORS route to a device credential)", async () => {
  const s = await setup();
  const { d, pair, redeem, phone, paired } = s;
  try {
    const a = await paired();
    const set = await d.ctx.app.inject({ method: "PUT", url: "/api/access/ui-origins", headers: d.withPin(), payload: { origins: ["http://localhost:5999"] } });
    assert.equal(set.statusCode, 200, set.body);
    const ui = { origin: "http://localhost:5999", "sec-fetch-site": "cross-site" };
    const c = await pair();
    const r = await phone("POST", "/api/devices/redeem", { body: { code: c.code }, headers: ui });
    assert.equal(r.status, 403, r.text);
    assert.equal(r.json.code, "cross_site");
    const x = await phone("POST", "/api/devices/session", { body: { secret: a.secret }, headers: ui });
    assert.equal(x.status, 403);
    assert.equal(x.json.code, "cross_site");
    // The code was not used up: the device's own page can still pair with it.
    assert.equal((await redeem(c.code)).status, 200);
  } finally {
    await d.close();
  }
});

test("review L-2: the owner sees the locks — making a code says a source is locked (the lock stays: it only holds that source); the list shows each; a PIN reset clears them", async () => {
  const s = await setup();
  const { d, pair, redeem } = s;
  try {
    for (let i = 0; i < DEVICE_LIMITS.redeemFailuresMax; i++) await redeem(newPairingCode());
    const list = await d.ctx.app.inject({ url: "/api/devices", headers: s.web });
    assert.ok(list.json().pairLockedUntil > Date.now(), "设置里看得到锁定");
    assert.equal(list.json().pairLocks.length, 1);
    assert.match(list.json().pairLocks[0].who, /^external:ip:/);
    // The owner (PIN) makes a new code: told a source is locked; that source stays locked, others pair.
    const c = await pair();
    assert.equal((c as any).wasLocked, true);
    assert.equal((c as any).recentFailures, DEVICE_LIMITS.redeemFailuresMax);
    assert.equal((await redeem(c.code)).status, 423);
    assert.equal(d.ctx.access.devices.redeem(c.code, { face: "external", bucket: "external:ip:192.0.2.7" }).device.state, "active");
    // A PIN reset clears every lock (and the counts).
    for (let i = 0; i < DEVICE_LIMITS.redeemFailuresMax; i++)
      assert.throws(() => d.ctx.access.devices.redeem(newPairingCode(), { face: "external", bucket: "x" }));
    assert.ok(d.ctx.access.devices.lockedFor("x") > 0);
    d.ctx.access.devices.dropEverything();
    assert.equal(d.ctx.access.devices.lockedFor(), 0);
    assert.equal((await d.ctx.app.inject({ url: "/api/devices", headers: s.web })).json().pairLockedUntil, null);
  } finally {
    await d.close();
  }
});

test("review L-3: revoking a device cuts a response it is already being streamed", async () => {
  const defs = group("system", {
    reviewStream: route({
      method: "GET",
      path: "/api/review-stream",
     
      scope: "daisy:session:read",
      output: binary("bytes"),
      cli: exempt(),
    }),
  });
  const s = await setup({
    before: (app) =>
      serve(app, defs.reviewStream, async (_req: any, reply: any) => {
        const body = new PassThrough();
        body.write("first-chunk\n");
        reply.header("content-type", "application/octet-stream");
        return reply.send(body);
      }),
  });
  const { d, ext, paired, revoke } = s;
  try {
    const a = await paired();
    const res = await fetch(ext + "/api/review-stream", { headers: { authorization: `Bearer ${a.token}` } });
    assert.equal(res.status, 200);
    const reader = res.body!.getReader();
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /first-chunk/);
    assert.equal((await revoke(a.deviceId)).statusCode, 200);
    const next = await Promise.race([
      reader.read().then(
        (r) => (r.done ? "ended" : "more"),
        () => "cut",
      ),
      new Promise((r) => setTimeout(() => r("still open"), 3000)),
    ]);
    assert.ok(next === "cut" || next === "ended", `吊销后流还开着：${next}`);
  } finally {
    await d.close();
  }
});

test("review L-1 (same class, P2-04's route): the one-time passcode is not traded for a web session from an external-interface origin — and no public route hands out a credential cross-origin", async () => {
  const s = await setup();
  const { d, phone } = s;
  try {
    const set = await d.ctx.app.inject({ method: "PUT", url: "/api/access/ui-origins", headers: d.withPin(), payload: { origins: ["http://localhost:5999"] } });
    assert.equal(set.statusCode, 200, set.body);
    const code = d.ctx.access.web.issueCode("external").code;
    const ui = { origin: "http://localhost:5999", "sec-fetch-site": "cross-site" };
    const r = await phone("POST", "/api/web/session", { body: { code }, headers: ui });
    assert.equal(r.status, 403, r.text);
    assert.equal(r.json.code, "cross_site");
    // Not used up: the page of the outside face itself can still trade it.
    const own = await phone("POST", "/api/web/session", { body: { code } });
    assert.equal(own.status, 200, own.text);
    // Every public route: none but those that hand out no credential —
    // health, and P5-02's TLS binding claim (signed, public by design) —
    // answers that origin.
    const noCredential = ["system.health", "system.tlsBinding", "system.locales"];
    for (const rt of API_ROUTES.filter((x) => x.scope === null)) {
      const x = await phone(rt.method, rt.path, { ...(rt.method === "GET" ? {} : { body: {} }), headers: ui });
      if (noCredential.includes(rt.id)) assert.notEqual(x.status, 403, rt.id);
      else assert.equal(x.json?.code, "cross_site", rt.id);
    }
  } finally {
    await d.close();
  }
});

test("P5-02 × P5-03: turning the relay off ends the outside face's device sessions too (as any outside-face web session); the pairing stays — the device trades its credential again", async () => {
  const s = await setup();
  const { d, phone, paired, devices } = s;
  try {
    const a = await paired("A");
    assert.equal((await phone("GET", "/api/me", { token: a.token })).status, 200);
    const off = await d.ctx.app.inject({ method: "DELETE", url: "/api/relay", headers: d.withPin() });
    assert.equal(off.statusCode, 200, off.body);
    // The session the device held (made on the outside face) is gone…
    assert.equal((await phone("GET", "/api/me", { token: a.token })).status, 401);
    // …its pairing is not: the credential still trades for a new one.
    const again = await phone("POST", "/api/devices/session", { body: { secret: a.secret } });
    assert.equal(again.status, 200, again.text);
    assert.equal((await phone("GET", "/api/me", { token: again.json.token })).status, 200);
    assert.equal((await devices("active")).some((x) => x.id === a.deviceId), true);
  } finally {
    await d.close();
  }
});
