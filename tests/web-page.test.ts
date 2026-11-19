/**
 * P1-08: the local web page — served by the Daisy process itself on both
 * faces (P1-03 kept the static files on the same router), and the session
 * notifications it shows (GET /api/notifications; 「一轮结束」 written where
 * a turn settles).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { checkServerIdentity } from "node:tls";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../packages/daisy/src/app.ts";
import { PIN_GRANT_HEADER } from "../packages/daisy/src/access/pin-seam.ts";
import { OWNER_ID } from "../packages/daisy/src/access/owner.ts";
import {
  approvalNotices,
  listNotifications,
  notificationWriter,
  turnNotice,
} from "../packages/daisy/src/sessions/notifications.ts";
import { api } from "../packages/contracts/src/api/index.ts";
import { pinDouble } from "./fixtures/pin-double.ts";
import {
  accessSummary,
  autoUpdateLine,
  pinBanner,
  pinProvenance,
  unseenCount,
  viaLabel,
} from "../packages/ui/src/settings-view.ts";
import { inUiLang, uiLang } from "./ui-pack.ts";

uiLang("zh-CN");

const INDEX = "<!doctype html><html><body><div id=root></div><script src=/_expo/static/js/app.js></script></body></html>";

function webDir() {
  const d = mkdtempSync(join(tmpdir(), "daisy-web-"));
  writeFileSync(join(d, "index.html"), INDEX);
  mkdirSync(join(d, "_expo/static/js"), { recursive: true });
  writeFileSync(join(d, "_expo/static/js/app.js"), "console.log('daisy')");
  return d;
}

type Got = { status: number; type: string; csp: string; body: string };
const get = (
  url: string,
  o: { headers?: Record<string, string>; ca?: string } = {},
) =>
  new Promise<Got>((ok, fail) => {
    const u = new URL(url);
    const req = (u.protocol === "https:" ? httpsRequest : httpRequest)(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        headers: o.headers,
        ...(o.ca
          ? {
              ca: o.ca,
              checkServerIdentity: (_h: string, cert: any) =>
                checkServerIdentity("127.0.0.1", cert),
            }
          : {}),
      },
      (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () =>
          ok({
            status: res.statusCode!,
            type: String(res.headers["content-type"] || ""),
            csp: String(res.headers["content-security-policy"] || ""),
            body: b,
          }),
        );
      },
    );
    req.on("error", fail);
    req.end();
  });

test("P1-08: the exported page is served by the Daisy process on the local face and on the outside face (TLS and plain)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-page-"));
  const web = webDir();
  const pin = pinDouble();
  const ctx = await createApp({
    dataDir: dir,
    workspaceHome: dir,
    workspaceRoots: [dir],
    webDir: web,
    pin,
    sharedHost: () => false,
  });
  try {
    const local = await ctx.app.listen({ host: "127.0.0.1", port: 0 });
    // Local face: the page, its assets, the app's own routes (SPA), the CSP.
    const page = await get(local + "/");
    assert.equal(page.status, 200);
    assert.match(page.type, /^text\/html/);
    assert.equal(page.body, INDEX);
    assert.match(page.csp, /default-src 'self'/);
    assert.match(page.csp, /connect-src 'self'/);
    const deep = await get(local + "/sessions/abc");
    assert.equal(deep.status, 200);
    assert.equal(deep.body, INDEX, "an app route falls back to the page");
    const js = await get(local + "/_expo/static/js/app.js");
    assert.equal(js.status, 200);
    assert.match(js.type, /javascript/);
    // /api is never the page: an unknown API path is JSON, not HTML.
    const api404 = await get(local + "/api/no-such-thing");
    assert.notEqual(api404.status, 200);
    assert.doesNotMatch(api404.type, /html/);
    // DNS rebinding: another Host gets no page either.
    const port = new URL(local).port;
    assert.equal((await get(local + "/", { headers: { host: `evil.example:${port}` } })).status, 403);

    // Outside face, TLS (default): the same page over https.
    const cli = readFileSync(join(dir, "keys", "cli-credential"), "utf8").trim();
    const on = (body: any) =>
      ctx.app.inject({
        method: "PUT",
        url: "/api/access/external",
        headers: {
          authorization: `Bearer ${cli}`,
          [PIN_GRANT_HEADER]: pin.grant("246810", "cli").grant,
        },
        payload: body,
      });
    const st = (await on({ host: "127.0.0.1" })).json();
    assert.equal(st.external.listening, true);
    const ca = readFileSync(join(dir, "keys", "tls-cert.pem"), "utf8");
    const ext = `https://127.0.0.1:${st.external.port}`;
    const tlsPage = await get(ext + "/", { ca });
    assert.equal(tlsPage.status, 200);
    assert.equal(tlsPage.body, INDEX);
    assert.match(tlsPage.csp, /default-src 'self'/);
    assert.equal((await get(ext + "/_expo/static/js/app.js", { ca })).status, 200);
    assert.equal((await get(ext + "/sessions/x", { ca })).body, INDEX);
    // …and plain HTTP on a private-network address (D-31: the owner's choice).
    const plain = (await on({ host: "127.0.0.1", tls: false })).json();
    assert.equal(plain.external.tls, false);
    const http = `http://127.0.0.1:${plain.external.port}`;
    const plainPage = await get(http + "/");
    assert.equal(plainPage.status, 200);
    assert.equal(plainPage.body, INDEX);
    assert.equal((await get(http + "/_expo/static/js/app.js")).status, 200);
    // The outside face still wants its own session for the API.
    assert.equal((await get(http + "/api/sessions")).status, 401);
  } finally {
    await ctx.app.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(web, { recursive: true, force: true });
  }
});

test("P1-08: GET /api/notifications — one row per item, its latest state; approval open → pending, closed → handled; a turn's end", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-notices-"));
  const ctx = await createApp({
    dataDir: dir,
    workspaceHome: dir,
    workspaceRoots: [dir],
    sharedHost: () => false,
  });
  const { store } = ctx;
  try {
    const token = ctx.issueToken();
    const as = { authorization: `Bearer ${token}` };
    const cat = (await ctx.app.inject({ url: "/api/catalog", headers: as })).json();
    const p = cat.profiles.find((x: any) => x.agent === "codex");
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: as,
      payload: {
        agent: "codex",
        title: "调研",
        profileId: p.id,
        workspaceId: cat.workspaces[0].id,
      },
    });
    assert.equal(created.statusCode, 200, created.body);
    const sid = created.json().id;
    // An approval card opens, then is answered.
    const notice = approvalNotices(store);
    notice(OWNER_ID, "card-1", "pending", "允许运行 npm test？", sid);
    // A turn ends well; another session's turn fails; a stopped turn says nothing.
    turnNotice(store, { id: "job-1", session_id: sid }, "idle");
    turnNotice(store, { id: "job-0", session_id: sid }, "interrupted", "已停止");
    const list = async (q = "") =>
      (await ctx.app.inject({ url: `/api/notifications${q}`, headers: as })).json();
    let r = await list();
    assert.equal(r.items.length, 2);
    const byKind = (k: string) => r.items.find((x: any) => x.kind === k);
    assert.equal(byKind("approval").state, "pending");
    assert.equal(byKind("approval").actionRequired, true);
    assert.equal(byKind("approval").sessionId, sid);
    assert.equal(byKind("ai_private_message").state, "unread");
    assert.equal(byKind("ai_private_message").title, "「调研」这一轮完成了");
    assert.equal(byKind("ai_private_message").notificationId, `turn:${sid}`);
    // Newest change first.
    assert.equal(r.items[0].kind, "ai_private_message");
    const cursor = r.cursor;
    assert.ok(cursor > 0);
    // The card is answered: the item closes (handled), keeps its title.
    notice(OWNER_ID, "card-1", "approved", "", sid);
    r = await list();
    assert.equal(byKind("approval").state, "handled");
    assert.equal(byKind("approval").title, "允许运行 npm test？");
    assert.equal(byKind("approval").sessionId, sid);
    // `after`: only what changed since.
    const since = await list(`?after=${cursor}`);
    assert.deepEqual(
      since.items.map((x: any) => x.kind),
      ["approval"],
    );
    // The next turn fails: the session's one turn item now says so.
    turnNotice(store, { id: "job-2", session_id: sid }, "error", "harness 退出了");
    r = await list(`?sessionId=${encodeURIComponent(sid)}`);
    const turn = r.items.find((x: any) => x.notificationId === `turn:${sid}`);
    assert.equal(turn.kind, "ai_failed");
    assert.equal(turn.category, "ai_failed");
    assert.match(turn.title, /出错：harness 退出了/);
    assert.equal(r.items.filter((x: any) => x.notificationId === `turn:${sid}`).length, 1);
    // A lost process is an error too (reap: keepPaused).
    turnNotice(store, { id: "job-3", session_id: sid }, "interrupted", "执行节点失联", true);
    assert.match(
      (await list()).items.find((x: any) => x.notificationId === `turn:${sid}`).title,
      /中断：执行节点失联/,
    );
    // Another session filter: nothing of this one.
    assert.equal((await list("?sessionId=nope")).items.length, 0);
    // device=web: the kind × device preferences decide `alert`.
    await ctx.app.inject({
      method: "PUT",
      url: "/api/notification-preferences",
      headers: as,
      payload: { matrix: { ai_failed: { web: false } } },
    });
    const withAlert = await list("?device=web");
    const failed = withAlert.items.find((x: any) => x.category === "ai_failed");
    assert.equal(failed.alert, false);
    assert.equal(failed.alertReason, "kind-off");
    // A closed card never alerts.
    assert.equal(
      withAlert.items.find((x: any) => x.kind === "approval").alertReason,
      "retract",
    );
    // Not the AI's: no working credential reaches it (P1-03's guard; the
    // table drives tests/access.test.ts too) — and no credential, no list.
    assert.equal((await ctx.app.inject({ url: "/api/notifications" })).statusCode, 401);
    const def = api.notifications.notifications;
    assert.equal(def.scope, "daisy:session:read");
    // P2-01: the owner's channels include the external issuer's token for the owner.
    assert.deepEqual([...def.channels], ["web", "device", "cli", "issuer"]);
    // Sidecars and deleted sessions raise no turn notice.
    store.run(
      "UPDATE sessions SET data=json_set(data,'$.sidecar',json('{\"parent\":\"x\"}')) WHERE id=?",
      sid,
    );
    assert.equal(turnNotice(store, { id: "job-4", session_id: sid }, "idle"), null);
    // Reading straight from the store gives the same rows.
    assert.equal(
      listNotifications(store, OWNER_ID).items.length,
      (await list()).items.length,
    );
    notificationWriter(store);
  } finally {
    await ctx.app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P1-08: what the settings page and the banner say (PIN history, auto-update, faces)", () => {
  const at = (ts: number) => `T${ts}`;
  const st = (o: Record<string, unknown>) =>
    ({ set: true, lockedUntil: null, setAt: null, setVia: null, resetAt: null, resetVia: null, ...o }) as any;
  // PIN: no fields from P1-05 → nothing shown; the latest event first.
  assert.deepEqual(pinProvenance(st({}), at), []);
  assert.deepEqual(
    pinProvenance(st({ setAt: 20, setVia: "web", resetAt: 10, resetVia: "cli" }), at),
    ["PIN 于 T20 经本地网页设置", "PIN 于 T10 经命令行重置"],
  );
  assert.deepEqual(pinProvenance(st({ set: false, resetAt: 5, resetVia: "unknown" }), at), [
    "PIN 于 T5重置",
  ]);
  assert.equal(viaLabel("device"), "配对设备");
  assert.equal(viaLabel("local"), "本机");
  assert.equal(viaLabel("unknown"), "");
  assert.equal(viaLabel("relay"), "relay");
  // The banner: only while no PIN is set; says so after a reset.
  assert.equal(pinBanner(null), null);
  assert.equal(pinBanner(st({})), null);
  assert.equal(pinBanner(st({ set: false }))!.title, "先设置 PIN，AI 才会开始工作");
  assert.match(pinBanner(st({ set: false, resetAt: 1, resetVia: "local" }))!.detail, /已被重置/);
  // Auto-update (one process: no remote devices, no manual command).
  assert.match(autoUpdateLine({ state: "disabled" }).text, /自动更新已关闭/);
  assert.equal(autoUpdateLine({ state: "current" }).tone, "ok");
  assert.equal(autoUpdateLine({ state: "pending", target: "abcdef0123" }).tone, "wait");
  assert.match(autoUpdateLine({ state: "failed", error: "构建失败" }).text, /自动更新失败：构建失败/);
  assert.match(autoUpdateLine(undefined).text, /未知/);
  // Faces.
  const a = {
    local: { url: "http://127.0.0.1:29201", port: 29201, portSource: "derived" as const },
    external: {
      enabled: true,
      listening: true,
      url: "http://100.64.0.2:29601",
      host: "100.64.0.2",
      port: 29601,
      tls: false,
      fingerprint: null,
      allow: { terminal: false, shell: false, browse: false },
    },
    passcode: { mode: "auto" as const, effective: true, sharedHost: false },
  };
  assert.equal(
    accessSummary(a),
    "本机：http://127.0.0.1:29201 · 对外：http://100.64.0.2:29601（明文 HTTP） · 打开网页需要一次性口令",
  );
  // Unseen: closed items are not news.
  const item = (id: number, state: any) => ({ id: String(id), state }) as any;
  assert.equal(unseenCount([item(5, "pending"), item(4, "handled"), item(2, "unread")], 3), 1);
});

test("P6-22: the settings page's lines in English (PIN history, banner, auto-update, faces)", async () => {
  const at = (ts: number) => `T${ts}`;
  const st = (o: Record<string, unknown>) =>
    ({ set: true, lockedUntil: null, setAt: null, setVia: null, resetAt: null, resetVia: null, ...o }) as any;
  await inUiLang("en", () => {
    assert.deepEqual(pinProvenance(st({ setAt: 20, setVia: "web", resetAt: 10, resetVia: "cli" }), at), [
      "PIN set at T20 through the local web page",
      "PIN reset at T10 through the command line",
    ]);
    assert.equal(viaLabel("device"), "a paired device");
    assert.match(pinBanner(st({ set: false }))!.title, /Set a PIN/);
    assert.match(pinBanner(st({ set: false, resetAt: 1 }))!.detail, /was reset.*Daisy starts no AI turns/);
    assert.match(autoUpdateLine({ state: "disabled" }).text, /Auto-update is off.*daisy update --apply/);
    assert.match(autoUpdateLine({ state: "available", target: "1.1.0" }).text, /New version 1\.1\.0/);
    assert.match(autoUpdateLine({ state: "failed", error: "boom" }).text, /^Auto-update failed: boom$/);
    const a = {
      local: { url: "http://127.0.0.1:29201", port: 29201, portSource: "derived" as const },
      external: { enabled: false, listening: false, url: null, host: null, port: 0, tls: false, fingerprint: null, allow: { terminal: false, shell: false, browse: false } },
      passcode: { mode: "auto" as const, effective: false, sharedHost: false },
    } as any;
    assert.equal(
      accessSummary(a),
      "This machine: http://127.0.0.1:29201 · The outside face is off · Opening the page on this machine needs no passcode",
    );
  });
  // Back in Chinese.
  assert.equal(viaLabel("device"), "配对设备");
});

test("P1-08: makeId without crypto.randomUUID (plain HTTP on a network address) is still a v4 UUID", async () => {
  const { makeId } = await import("../packages/client/src/index.ts");
  const saved = Object.getOwnPropertyDescriptor(globalThis, "crypto")!;
  const real = globalThis.crypto;
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { getRandomValues: (a: Uint8Array<ArrayBuffer>) => real.getRandomValues(a) },
  });
  try {
    const ids = new Set(Array.from({ length: 200 }, () => makeId()));
    assert.equal(ids.size, 200);
    for (const id of ids)
      assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  } finally {
    Object.defineProperty(globalThis, "crypto", saved);
  }
});
