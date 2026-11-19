/**
 * 原则 6（入口等价）for the command line: what the web page can do, the
 * `daisy` command can do — the only exceptions are answering one's own
 * AI's tool approvals and questions (web and paired devices only), and the
 * 「放别人进来」 operations, which every entry point can do but only with the
 * PIN. Checked against the route table and the command as built.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  API_ROUTES,
  LOCAL_COMMANDS,
  cliCommands,
} from "../packages/contracts/src/index.ts";
import { TREE } from "../packages/daisy/src/cli/main.ts";
import { LOCAL } from "../packages/daisy/src/cli/local/commands.ts";
import { daisy, fakeDaisy, testIo } from "./cli-fixture.ts";
import { translator as zhTranslator } from "../packages/contracts/src/i18n.ts";
import { shippedPacks as zhPacks } from "../packages/contracts/src/i18n-node.ts";
import { exemptText, routeText } from "../packages/contracts/src/api/route.ts";
/** P6-23a: the route table's text is in the packs; these assertions read the Chinese. */
const zh = zhTranslator(zhPacks(), "zh-CN");

const isExempt = (r: (typeof API_ROUTES)[number]) => "exempt" in r.cli;

test("every route the web page can call is a command, or one of the named exemptions", () => {
  const commands = new Map(cliCommands(API_ROUTES).map((c) => [c.route, c]));
  for (const r of API_ROUTES) {
    if (!r.channels.includes("web")) continue;
    if (commands.has(r.id)) {
      assert.ok(r.channels.includes("cli"), `${r.id}: a command the command line may not call`);
      continue;
    }
    assert.ok(isExempt(r), `${r.id}: neither a command nor exempt`);
    const why = exemptText(r, zh) ?? "";
    // The exception of 原则 6: answering the AI is web / paired device only.
    const answersAi = /替 AI 点头|原则 6 的例外/.test(why);
    // Not an exception: a local command does it, or it is not an operation
    // of the owner (a socket, a second spelling, the web page's own session).
    const local = /由本地命令 daisy (\w+)/.exec(why)?.[1];
    assert.ok(
      answersAi ||
        (local
          ? (LOCAL_COMMANDS as readonly string[]).includes(local)
          : /WebSocket|另一种写法|网页自己|网页会话的注销|外部平台|推送发送方|命令行不单独换授权/.test(why)),
      `${r.id}: exemption not one of the allowed kinds: ${why}`,
    );
    if (!r.channels.includes("cli"))
      assert.ok(answersAi || /网页会话的注销/.test(why), `${r.id}: closed to the command line without being an exception`);
    // The owner in person; never the command line, nor (until the stage
    // gate decides, ADR-113) the external issuer's token.
    if (answersAi) assert.deepEqual([...r.channels].sort(), ["device", "web"], r.id);
  }
});

test("「放别人进来」 (PIN) routes are reachable from the command line, and it asks for the PIN", () => {
  for (const r of API_ROUTES.filter((x) => x.pin)) {
    assert.ok(r.channels.includes("cli"), `${r.id}: the command line can do it (with the PIN)`);
    const c = cliCommands(API_ROUTES).find((x) => x.route === r.id);
    if (c) assert.equal(c.pin, true, r.id);
    else assert.match(exemptText(r, zh) ?? "", /由本地命令 daisy \w+/, r.id);
  }
});

test("the exemptions a local command covers are really called by it", async () => {
  const d = await fakeDaisy((r) =>
    r.path === "/api/web/open-code" || r.path === "/api/web/open-code/external"
      ? { json: { code: "c", url: "http://127.0.0.1:1/#code=c", expiresAt: 0 } }
      : r.path === "/api/pin/grant"
        ? { json: { grant: "g", expiresAt: 0 } }
        : undefined,
  );
  try {
    const hit = (p: string) => d.requests.some((r) => r.path === p);
    await daisy(testIo({ env: { SSH_CONNECTION: "x" } }), d.dataDir, "open");
    assert.ok(hit("/api/web/open-code"), "daisy open → settings.openCode");
    await daisy(testIo({ input: ["123456"] }), d.dataDir, "open", "--external");
    assert.ok(hit("/api/web/open-code/external"), "daisy open --external → settings.openCodeExternal");
    for (const r of API_ROUTES) {
      const why = isExempt(r) ? (exemptText(r, zh) ?? "") : "";
      const local = /由本地命令 daisy (\w+)/.exec(why)?.[1];
      if (!local) continue;
      assert.ok(LOCAL[local], `${r.id}: daisy ${local} exists`);
    }
  } finally {
    await d.close();
  }
});

test("the command tree: local commands are exactly LOCAL_COMMANDS, every table command is a leaf reachable by its words", () => {
  assert.deepEqual(Object.keys(LOCAL).sort(), [...LOCAL_COMMANDS].sort());
  const names = TREE.children.map((c) => c.name);
  for (const l of LOCAL_COMMANDS) assert.ok(!names.includes(l), `${l} is not also a table group`);
  assert.ok(!names.includes("help"));
  const walk = (n: typeof TREE, depth: number): number => {
    if (n.command) {
      assert.equal(n.children.length, 0, `${n.command.path.join(" ")} is a leaf`);
      return 1;
    }
    assert.ok(depth === 0 || n.children.length > 0);
    return n.children.reduce((s, c) => s + walk(c, depth + 1), 0);
  };
  assert.equal(walk(TREE, 0), cliCommands(API_ROUTES).length);
  // 5.10's phase-1 commands are all there.
  for (const top of ["start", "stop", "status", "open", "login", "session", "autostart", "update", "doctor", "uninstall"])
    assert.ok((LOCAL_COMMANDS as readonly string[]).includes(top) || names.includes(top), top);
});
