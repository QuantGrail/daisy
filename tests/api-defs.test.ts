/**
 * P1-06 (ADR-107): the local API has one definition per route. These
 * tests hold the table to that: every `/api/*` route the server registers
 * comes from a definition (and every definition is registered); every
 * route has a command or a written reason why not; the committed docs are
 * what the table generates; a new definition shows up in the docs and the
 * command line with nothing else written.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { z } from "zod";
import { createApp } from "../packages/daisy/src/app.ts";
import { serve, routeDef } from "../packages/daisy/src/app/serve.ts";
import {
  API_GROUPS,
  API_ROUTES,
  API_VERSION,
  api,
  apiMarkdown,
  cliCommands,
  cliExemptions,
  cliHelp,
  cliTree,
  isExempt,
  LOCAL_COMMANDS,
  pathParams,
  type AnyRoute,
} from "../packages/contracts/src/index.ts";
import {
  cmd,
  exempt,
  group,
  json,
  route,
} from "../packages/contracts/src/api/route.ts";
import { DaisyClient } from "../packages/client/src/index.ts";
import { apiDocFiles } from "../scripts/gen-api-docs.ts";
import { translator } from "../packages/contracts/src/i18n.ts";
import { shippedPacks } from "../packages/contracts/src/i18n-node.ts";
import { exemptText, routeText } from "../packages/contracts/src/api/route.ts";

// P6-23a (ADR-159 §7): the route table's text is in the packs.
const zh = translator(shippedPacks(), "zh-CN");

const key = (r: { method: string; path?: string; url?: string }) =>
  `${r.method} ${r.path ?? r.url}`;

test("the table: unique ids and routes, params match the path, groups known", () => {
  assert.ok(API_ROUTES.length > 0);
  const ids = new Set<string>(),
    routes = new Set<string>();
  const groups = new Set(API_GROUPS.map((g) => g.id));
  for (const r of API_ROUTES) {
    assert.ok(!ids.has(r.id), `重复的接口 id ${r.id}`);
    ids.add(r.id);
    assert.ok(!routes.has(key(r)), `重复的接口 ${key(r)}`);
    routes.add(key(r));
    assert.ok(groups.has(r.group), `${r.id}: 未知分组 ${r.group}`);
    // P4-04: the A2A entry lives under /a2a (a2a-usage.md §2), everything else under /api.
    if (r.group === "a2a") assert.match(r.path, /^\/a2a(\/|$)/, `${r.id}: A2A 入口不在 /a2a 下`);
    // P5-02: the TLS binding claim is at a well-known path (a2a-usage.md §15.1).
    else if (r.id === "system.tlsBinding") assert.equal(r.path, "/.well-known/daisy-tls-binding");
    else assert.match(r.path, /^\/api\//, `${r.id}: 路径不在 /api 下`);
    // Only the A2A entry is the visitors' (5.11 「外面来的」).
    assert.equal(!!r.visitors, r.group === "a2a", `${r.id}: 只有 A2A 入口对来访者开放`);
    assert.ok(zh.has(`api.route.${r.id}.summary`), `${r.id}: 缺一句话说明`);
    assert.deepEqual(
      Object.keys(r.params.shape).sort(),
      pathParams(r.path).sort(),
      `${r.id}: params 与路径参数不一致`,
    );
    // GET carries no body (the client sends none).
    if (r.method === "GET") assert.equal(r.body, undefined, `${r.id}: GET 带请求体`);
  }
});

test("原则 6: every route has a command or a written reason; commands are a clean tree", () => {
  for (const r of API_ROUTES) {
    if (isExempt(r.cli))
      assert.ok(
        (exemptText(r, zh) ?? "").trim().length >= 6 && !/^api\./.test(exemptText(r, zh)!),
        `${r.id}: 没有命令，也没写明理由`,
      );
    else assert.ok(r.cli.command.length > 0, `${r.id}: 命令为空`);
    // 5.11: answering the AI's tool approvals / questions is web and paired
    // devices only — no command for it.
    if (!r.channels.includes("cli"))
      assert.ok(isExempt(r.cli), `${r.id}: 命令行不能调用，却有命令`);
  }
  const commands = cliCommands(API_ROUTES);
  const paths = commands.map((c) => c.path.join(" "));
  assert.equal(new Set(paths).size, paths.length, "两条接口用了同一个命令");
  // A command is a leaf: never also the parent of another command.
  for (const p of paths)
    for (const q of paths)
      assert.ok(!q.startsWith(p + " "), `命令 ${p} 又是 ${q} 的上一级`);
  for (const c of commands) {
    for (const w of c.path) assert.match(w, /^[a-z][a-z0-9-]*$/, `命令名 ${w}`);
    // P1-07's own commands keep their names (no leaf under a leaf).
    assert.ok(
      !(LOCAL_COMMANDS as readonly string[]).includes(c.path[0]!),
      `${c.path.join(" ")}: 与本地命令 daisy ${c.path[0]} 冲突`,
    );
    const flags = c.options.map((o) => o.flag);
    assert.equal(new Set(flags).size, flags.length, `${c.path.join(" ")}: 选项重名`);
    // A positional argument and an option never share a name.
    for (const a of c.args)
      assert.ok(
        !c.options.some((o) => o.name === a.name),
        `${c.path.join(" ")}: 参数 <${a.name}> 与选项 --${a.name} 同名`,
      );
    assert.match(cliHelp(c, zh), /^用法：daisy /);
  }
  assert.equal(
    commands.length + cliExemptions(API_ROUTES).length,
    API_ROUTES.length,
  );
});

test("5.11: the AI's working credential reaches only routes scoped to its own session", () => {
  for (const r of API_ROUTES) {
    const open = r.channels.includes("ai");
    assert.equal(open, !!r.aiSelf, `${r.id}: 对 AI 开放当且仅当写了 aiSelf`);
    if (!open) continue;
    assert.ok(
      pathParams(r.path).includes(r.aiSelf!),
      `${r.id}: aiSelf ${r.aiSelf} 不是路径参数`,
    );
    // P2-02: the one AI tool on the local API — a token for the MCP in its
    // harness (5.11 「AI 自用的工具」: the AI only, never the owner's channels).
    if (r.id === "session.aiToken") {
      assert.equal(r.scope, "daisy:tools");
      assert.deepEqual(r.channels, ["ai"]);
      assert.equal(r.pin, false);
    } else {
      // The AI reads its own session (5.11 「只限自己这个会话」); nothing else.
      assert.equal(r.scope, "daisy:session:read", `${r.id}: AI 只能读`);
      assert.equal(r.method, "GET", `${r.id}: AI 只能读`);
    }
    assert.match(r.path, /^\/api\/sessions\/:/, `${r.id}: 不是某个会话下的接口`);
    // aiSelf must be the session id itself, not another path parameter.
    assert.ok(
      r.path === `/api/sessions/:${r.aiSelf}` || r.path.startsWith(`/api/sessions/:${r.aiSelf}/`),
      `${r.id}: aiSelf 必须是紧跟 /api/sessions/ 的会话参数`,
    );
  }
  assert.deepEqual(
    API_ROUTES.filter((r) => r.scope === "daisy:tools").map((r) => r.id),
    ["session.aiToken"],
  );
  // Named in the review (5.11 rows where the AI column is 「—」).
  for (const id of [
    "session.list",
    "session.create",
    "session.shellStatus",
    "approval.list",
    "approval.show",
    "approval.comments",
    "attachment.download",
    "system.live",
    "system.me",
    "settings.webLogout",
    "settings.openCode",
  ])
    assert.ok(
      !API_ROUTES.find((r) => r.id === id)!.channels.includes("ai"),
      `${id} 不应对 AI 开放`,
    );
  // Answering the AI's approvals: the owner in person — the web page or a
  // paired device. Never the command line; not the external issuer's token
  // either until the stage gate decides (review of P2-01, ADR-113).
  for (const id of ["approval.respond", "session.answerApproval"])
    assert.deepEqual(API_ROUTES.find((r) => r.id === id)!.channels, ["web", "device"]);
});

test("P1-03: the routes P1-06 marked for removal are gone; nothing is left marked", () => {
  for (const r of API_ROUTES) assert.equal(r.removal, undefined, `${r.id}: 还标着 removal`);
  const gone = [
    ["POST", "/api/host/token"],
    ["POST", "/api/login"],
    ["POST", "/api/logout"],
    ["POST", "/api/password"],
    ["GET", "/api/users"],
    ["POST", "/api/users"],
    ["GET", "/api/nodes/mine"],
    ["GET", "/api/nodes"],
    ["DELETE", "/api/nodes/:id"],
    ["GET", "/api/network/devices"],
    ["POST", "/api/profiles/:id/assign"],
  ];
  for (const [m, p] of gone)
    assert.ok(!API_ROUTES.some((r) => r.method === m && r.path === p), `${m} ${p} 还在`);
  // No route authenticates by the gateway secret any more.
  for (const r of API_ROUTES) assert.notEqual(r.auth as string, "gateway-secret", r.id);
});

test("P1-03: what is public, what needs the PIN, what the outside face keeps off", () => {
  // Public: health, the web page's session exchange (its own code), and
  // P5-02's TLS binding claim (signed, public by design: a2a-usage.md §15.1).
  // P5-03: a device trading its pairing code / its device credential
  // (each checked by its handler; the outside face only).
  assert.deepEqual(
    API_ROUTES.filter((r) => r.scope === null).map((r) => r.id).sort(),
    ["settings.deviceSession", "settings.pairRedeem", "settings.webSession", "system.health", "system.locales", "system.tlsBinding"],
  );
  assert.equal(API_ROUTES.find((r) => r.id === "settings.pairRedeem")!.auth, "pairing-code");
  assert.equal(API_ROUTES.find((r) => r.id === "settings.deviceSession")!.auth, "device-secret");
  // 「放别人进来」: a daisy:grant change goes with the PIN (scopes.md §2).
  // Except the two PIN routes themselves: trading the PIN for a grant, and
  // the local reset (you reset what you forgot) — P1-05. Reads take the
  // PIN on the command line only (D-40 ①, phase-4 gate: its credential may
  // be the owner's AI); the web page and the other owner entries read freely.
  const READS_CLI_PIN = [
    "grant.contactExport",
    "grant.contactInspect",
    "grant.contactList",
    "grant.contactShow",
    "grant.requestList",
    "grant.requestShow",
    "grant.grantList",
    "grant.audienceShow",
    "grant.actShow",
    "grant.residentList",
    "grant.residentShow",
    "grant.tokenList",
    "grant.agentList",
    // P5-03: the paired devices.
    "settings.deviceList",
  ];
  for (const id of READS_CLI_PIN) {
    const r = API_ROUTES.find((x) => x.id === id)!;
    assert.equal(r.pin, true, id);
    assert.deepEqual(r.pinOn, ["cli"], `${id}: 只在命令行要 PIN（D-40）`);
    assert.equal(r.letsIn, undefined, id);
    assert.equal(r.scope, "daisy:grant", `${id}: 仍要 daisy:grant`);
    assert.ok(!r.channels.includes("ai"), `${id}: AI 读不到`);
  }
  for (const r of API_ROUTES)
    if (
      r.scope === "daisy:grant" &&
      ![
        "settings.pinGrant",
        "settings.pinReset",
        // P4-07 (ADR-126 §6): narrowing a resident agent (notLetIn).
        "grant.residentPause",
        "grant.residentClose",
        "grant.residentDelete",
      ].includes(r.id)
    )
      assert.equal(r.pin, true, `${r.id}: grant 没要 PIN`);
  assert.deepEqual(API_ROUTES.find((r) => r.id === "settings.pinReset")!.channels, ["cli"]);
  for (const id of [
    "settings.externalOn",
    "settings.passcode",
    "settings.openCodeExternal",
    "settings.issuerSet",
    "settings.uiOriginsSet",
    // P4-01: 「添加、移除互认的名片」, the whitelist.
    "grant.contactImport",
    "grant.contactRemove",
    "grant.contactWhitelistAdd",
    "grant.contactWhitelistRemove",
    // P4-03: call authorization — deciding, revoking, the range.
    "grant.requestDecide",
    "grant.grantRevoke",
    "grant.audienceSet",
    // P4-05: 是否允许办 / 办的权限模式 (5.11 「设置是否允许办」).
    "grant.actSet",
    // P4-06: 把会话设为公开或收回 (5.11).
    "grant.publicSet",
    // P4-07: resident agents (5.11 「创建、修改常驻 agent」).
    "grant.residentCreate",
    "grant.residentSet",
    "grant.residentResume",
    // P4-12: daisy token (5.11 / scopes.md 「签发、吊销 daisy token」).
    "grant.tokenIssue",
    "grant.tokenRevoke",
  ])
    assert.equal(API_ROUTES.find((r) => r.id === id)!.pin, true, id);
  // D-31: terminal, commands and folder browsing are off on the outside face.
  const gated = Object.fromEntries(
    API_ROUTES.filter((r) => r.external).map((r) => [r.id, r.external]),
  );
  assert.deepEqual(gated, {
    "session.shellRun": "shell",
    "session.shellStatus": "shell",
    "session.terminalList": "terminal",
    "session.terminalOutput": "terminal",
    "session.terminalInput": "terminal",
    "session.terminalOpen": "terminal",
    "session.harnessConfig": "shell",
    "workspace.browse": "browse",
    "workspace.browseResult": "browse",
  });
  // Review of P1-06: changing the harness's configuration is management.
  assert.equal(API_ROUTES.find((r) => r.id === "session.harnessConfig")!.scope, "daisy:manage");
  const body = API_ROUTES.find((r) => r.id === "session.operation")!.body!;
  for (const name of ["config.write", "mcp.add", "mcp.remove", "plugin.install", "plugin.uninstall", "skill.write", "terminal"])
    assert.equal(body.safeParse({ requestId: "r-12345678", name }).success, false, name);
  assert.equal(body.safeParse({ requestId: "r-12345678", name: "compact" }).success, true);
});

test("credentials and files never come as command-line values", () => {
  const byRoute = new Map(cliCommands(API_ROUTES).map((c) => [c.route, c]));
  const opt = (route: string, name: string) =>
    byRoute.get(route)!.options.find((o) => o.name === name)!;
  assert.equal(opt("profile.create", "apiKey").source, "prompt");
  assert.equal(opt("profile.loginInput", "code").source, "prompt");
  assert.equal(opt("attachment.upload", "data").source, "file");
  for (const c of byRoute.values())
    for (const a of c.args) assert.notEqual(a.source, "prompt", `${c.route}: 凭据作位置参数`);
  assert.match(
    cliHelp(byRoute.get("profile.loginInput")!, zh),
    /--code\s+授权码（从标准输入或提示读取，不接受命令行里的值，/,
  );
  // The idempotency key the command fills itself is no option.
  assert.ok(!byRoute.get("session.terminalInput")!.options.some((o) => o.name === "id"));
  assert.equal(byRoute.get("session.terminalInput")!.idempotencyKey, "id");
  // Stage 1 makes every new session private: no option to say otherwise.
  const create = byRoute.get("session.create")!.options.map((o) => o.name);
  assert.ok(!create.includes("visibility") && !create.includes("visibleTo"));
});

test("the server registers every /api route from its definition, and every definition", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daisy-api-defs-"));
  const { app, registeredRoutes } = await createApp({ pinGate: false,
    dataDir: dir,
    workspaceHome: dir,
    workspaceRoots: [dir],
  });
  try {
    await app.ready();
    const seen = registeredRoutes().filter(
      (r) => r.url.startsWith("/api/") || r.url === "/a2a" || r.url.startsWith("/a2a/") || r.url.startsWith("/.well-known/"),
    );
    const byId = new Map(API_ROUTES.map((r) => [r.id, r]));
    const outside = seen.filter((r) => !r.api).map(key);
    assert.deepEqual(outside, [], "这些 /api、/a2a、/.well-known 路由没有经接口定义注册");
    for (const r of seen) {
      const def = byId.get(r.api!)!;
      assert.equal(key(r), key(def), `${r.api} 注册的方法或路径与定义不同`);
    }
    const registered = seen.map((r) => r.api).sort();
    assert.deepEqual(
      registered,
      API_ROUTES.map((r) => r.id).sort(),
      "定义与注册的接口一一对应",
    );
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("docs/api is what the table generates (npm run gen:api)", () => {
  for (const [rel, text] of Object.entries(apiDocFiles()))
    assert.equal(
      // A Windows checkout may turn LF into CRLF (core.autocrlf): not a change.
      readFileSync(join(import.meta.dirname, "..", rel), "utf8").replace(/\r\n/g, "\n"),
      text,
      `${rel} 过期：运行 npm run gen:api 后提交`,
    );
});

test("a new route is one definition: the docs, the command line and the server follow", async () => {
  const extra = group("system", {
    echo: route({
      method: "POST",
      path: "/api/echo/:id",
      scope: "daisy:manage",
      body: z.object({
        text: z.string().max(10).describe("api.route.system.echo.field.text"),
        loud: z.boolean().optional(),
      }),
      output: json(z.object({ id: z.string(), text: z.string() })),
      cli: cmd("echo say"),
    }),
    hidden: route({
      method: "GET",
      path: "/api/echo",
      scope: null,
      output: json<{ ok: true }>("{ ok: true }"),
      cli: exempt(),
    }),
  });
  const routes: AnyRoute[] = [...API_ROUTES, extra.echo, extra.hidden];
  // Its text: keys in the packs (here added for the test).
  const packs = shippedPacks();
  const t = translator(
    {
      ...packs,
      "zh-CN": {
        ...packs["zh-CN"],
        "api.route.system.echo.summary": "回声：原样返回",
        "api.route.system.echo.field.text": "要回声的文字",
        "api.route.system.hidden.summary": "回声的状态",
        "api.route.system.hidden.exempt": "只供示例：说明豁免理由会进文档",
      },
    },
    "zh-CN",
  );
  assert.equal(routeText("system.hidden", "summary", t), "回声的状态");
  // The docs.
  const md = apiMarkdown({ routes, groups: API_GROUPS, apiVersion: API_VERSION, t });
  assert.match(md, /### system\.echo/);
  assert.match(md, /`POST \/api\/echo\/:id` — 回声：原样返回/);
  assert.match(md, /\| `text` \| string \| 是 \| ≤ 10 字符 \| 要回声的文字 \|/);
  assert.match(md, /`daisy echo say <id>`/);
  assert.match(md, /只供示例：说明豁免理由会进文档/);
  // The command line.
  const say = cliTree(routes)
    .children.find((n) => n.name === "echo")
    ?.children.find((n) => n.name === "say")?.command;
  assert.ok(say);
  assert.deepEqual(say.args.map((a) => a.name), ["id"]);
  assert.deepEqual(say.options.map((o) => o.flag), ["--text", "--loud"]);
  assert.match(cliHelp(say, t), /用法：daisy echo say <id> \[选项\]/);
  assert.match(cliHelp(say, t), /--text\s+要回声的文字（string，≤ 10 字符，必填）/);
  // The server: registered from the definition, validating with its schema.
  const app = Fastify();
  serve(app, extra.echo, async (req) => {
    assert.equal(routeDef(req)?.id, "system.echo");
    const b = extra.echo.body.parse(req.body);
    return { id: req.params.id, text: b.text };
  });
  app.setErrorHandler((e: any, _req, reply) =>
    reply.code(e instanceof z.ZodError ? 400 : 500).send({ error: e.message }),
  );
  const ok = await app.inject({
    method: "POST",
    url: "/api/echo/a1",
    payload: { text: "hi" },
  });
  assert.deepEqual(ok.json(), { id: "a1", text: "hi" });
  const bad = await app.inject({
    method: "POST",
    url: "/api/echo/a1",
    payload: { text: "x".repeat(11) },
  });
  assert.equal(bad.statusCode, 400);
  await app.close();
});

test("the client calls a route by its definition (path, query, body, typed answer)", async () => {
  const calls: { url: string; method: string; body?: string }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: any) => {
    calls.push({ url, method: init.method, body: init.body });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as any;
  try {
    const c = new DaisyClient("http://x", "t");
    const r = await c.call(api.sessions.cancel, { params: { id: "s/1" } });
    assert.equal(r.ok, true);
    await c.call(api.sessions.list, { query: { taskId: "T 1" } });
    await c.call(api.sessions.update, {
      params: { id: "s1" },
      body: { title: "新标题" },
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(
    calls.map((x) => [x.method, x.url, x.body]),
    [
      ["POST", "http://x/api/sessions/s%2F1/cancel", "{}"],
      ["GET", "http://x/api/sessions?taskId=T+1", undefined],
      ["PATCH", "http://x/api/sessions/s1", JSON.stringify({ title: "新标题" })],
    ],
  );
});

test("P6-25: every code a route lists is one the code that answers actually names (no typos in `errors`)", () => {
  const walk = (d: string, out: string[] = []): string[] => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.ts$/.test(f)) out.push(p);
    }
    return out;
  };
  // A code is a string literal somewhere in the code that answers (the
  // server, the shared A2A packages, contracts outside the route table).
  const thrown = new Set<string>();
  for (const f of ["packages/daisy/src", "packages/a2a-client/src", "packages/a2a-mcp/src", "packages/contracts/src"].flatMap((d) => walk(d)))
    if (!f.includes("contracts/src/api/"))
      for (const m of readFileSync(f, "utf8").matchAll(/"([a-z][a-z0-9_]*)"/g)) thrown.add(m[1]!);
  const unknown = API_ROUTES.flatMap((r) => (r.errors ?? []).filter((c) => !thrown.has(c)).map((c) => `${r.id}: ${c}`));
  assert.deepEqual(unknown, []);
});
