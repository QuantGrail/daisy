/**
 * P6-22 (ADR-159): the app shell (index.tsx: login, new work, navigation,
 * overview), the command center (commands.tsx), the working-folder picker,
 * the session header, the approvals inbox and the notifications panel speak
 * the UI's language pack — Chinese as before, English when chosen.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PRODUCT_NAME, COMMAND_NAME } from "../packages/contracts/src/names.ts";
import { cjkLines } from "../scripts/i18n-scan.ts";
import { t } from "../packages/ui/src/i18n.ts";
import { inUiLang, uiLang, uiMessages } from "./ui-pack.ts";

uiLang("zh-CN");

const FILES = [
  "packages/ui/src/index.tsx",
  "packages/ui/src/commands.tsx",
  "packages/ui/src/workspace.tsx",
  "packages/ui/src/agent-session.tsx",
  "packages/ui/src/approval-inbox.tsx",
  "packages/ui/src/notifications.tsx",
];

test("P6-22: the shell, commands, workspace, session, inbox and notifications files keep no Chinese and name only keys that exist", () => {
  const en = uiMessages("en");
  for (const f of FILES) {
    const src = readFileSync(f, "utf8");
    assert.deepEqual(cjkLines(src), [], `${f} still has Chinese text`);
    for (const m of src.matchAll(/(?<![\w.])(?:t|uiT)\(\s*"([a-z][\w.-]*)"/g))
      assert.ok(m[1]! in en, `${f}: ${m[1]} is not in the packs`);
    for (const m of src.matchAll(/t\.dynamic\(`(ui-[\w-]+\.[\w.]+)\.\$\{/g))
      assert.ok(Object.keys(en).some((k) => k.startsWith(m[1]! + ".")), `${f}: no keys under ${m[1]}`);
  }
  // The dynamic kinds and states of the notifications panel are all there.
  for (const k of ["approval", "ai_private_message", "ai_failed", "task"]) assert.ok(`ui-inbox.notify.kind.${k}` in en);
  for (const k of ["pending", "handled", "canceled", "expired"]) assert.ok(`ui-inbox.notify.state.${k}` in en);
});

test("P6-22: the login screen, new work and the navigation in Chinese (as before) and in English", async () => {
  assert.equal(t("ui-app.login.welcome"), `欢迎回到 ${PRODUCT_NAME}`);
  assert.equal(t("ui-app.login.submit"), `连接 ${PRODUCT_NAME} →`);
  assert.match(t("ui-app.login.codeHelp"), new RegExp(`${COMMAND_NAME} open --external`));
  assert.equal(t("ui-app.new.title"), "开启新的工作");
  assert.equal(t("ui-app.nav.calls", { count: 2 }), "☎ 待批准的调用（2）");
  assert.equal(t("ui-app.nav.online", { background: t("ui-app.nav.background", { count: 3 }) }), " · 在线 · 后台 3 项");
  await inUiLang("en", () => {
    assert.equal(t("ui-app.login.welcome"), `Welcome back to ${PRODUCT_NAME}`);
    assert.match(t("ui-app.login.pairHelp"), /pairing code/i);
    assert.match(t("ui-app.login.codeHelp"), /passcode/);
    assert.match(t("ui-app.new.noProfile", { agent: "Codex" }), /^No Codex profile yet/);
    assert.equal(t("ui-app.nav.calls", { count: 2 }), "☎ Calls to approve (2)");
    assert.equal(t("ui-app.nav.online", { background: t("ui-app.nav.background", { count: 3 }) }), " · online · 3 in the background");
    assert.match(t("ui-app.workspace.where", { node: "mac" }), /^mac · the path is on this execution machine/);
    assert.equal(t("ui-app.device.defaultName"), "My device");
  });
});

test("P6-22: the command center's sentences in both languages", async () => {
  const sizes = { before: "120.0K", after: "30.0K" };
  assert.equal(
    t("ui-commands.compact.doneSizes", { ...sizes, took: t("ui-commands.compact.took", { seconds: "2.5" }) }),
    "✓ 已压缩上下文：120.0K → 30.0K tokens（用时 2.5 秒）。对话里也记了一条，上下文圆圈已更新。",
  );
  assert.equal(t("ui-commands.model.saved", { more: "" }).trim(), "只改了这个会话，下一轮生效。");
  assert.equal(t("ui-commands.identity.switched", { profile: "GLM" }), "已换成「GLM」。下一条消息起用新身份继续这段对话；会话里单独选的模型已清除。");
  await inUiLang("en", () => {
    assert.match(
      t("ui-commands.compact.doneSizes", { ...sizes, took: t("ui-commands.compact.took", { seconds: "2.5" }) }),
      /^✓ Context compacted: 120\.0K → 30\.0K tokens \(took 2\.5 s\)\./,
    );
    assert.match(t("ui-commands.model.scope", { current: t("ui-commands.model.current", { runtime: "gpt · high" }) }), /Currently in use: gpt · high\.$/);
    assert.equal(t("ui-commands.palette.hint"), "Commands · ↑ ↓ to choose · Enter to open · Esc to close");
    assert.match(t("ui-commands.identity.switched", { profile: "GLM" }), /^Switched to "GLM"/);
  });
});

test("P6-22: the session header, approvals inbox and notifications in both languages", async () => {
  assert.equal(t("ui-app.session.deleteRunning"), "它还在运行：会立刻停止，对话记录一并删除，不能恢复。");
  assert.equal(t("ui-inbox.approval.listTitle", { count: 3 }), "AI 的审批 · 3 个待你决定");
  assert.equal(t("ui-inbox.notify.buttonUnseen", { count: 4 }), "◔ 通知 · 4");
  assert.equal(t.dynamic("ui-inbox.notify.kind.ai_private_message"), "一轮结束");
  await inUiLang("en", () => {
    assert.equal(t("ui-app.session.deleteTitle"), "Delete this session?");
    assert.equal(t("ui-inbox.approval.listTitle", { count: 3 }), "The AI's approvals · 3 waiting for you");
    assert.equal(t("ui-inbox.approval.decidedAs", { option: "Allow" }), "Decided: Allow");
    assert.equal(t("ui-inbox.notify.mark", { mark: t("ui-inbox.notify.mark.approval") }), " · needs approval");
    assert.equal(t.dynamic("ui-inbox.notify.state.canceled"), "Withdrawn");
    assert.match(t("ui-inbox.notify.empty"), /^No notifications yet/);
  });
});

test("P6-25: the UI hands its language to the client library (its own errors) and to the terminal page", async () => {
  const { ClientError } = await import("../packages/client/src/index.ts");
  const { UI_AREAS } = await import("../packages/ui/src/i18n.ts");
  const { terminalPageUrl } = await import("../packages/ui/src/terminal-url.ts");
  assert.ok((UI_AREAS as readonly string[]).includes("client"), "the UI loads the client area");
  const C = { terminalBg: "#000", terminalInk: "#fff", terminalMuted: "#999", terminalKey: "#111", terminalKeyInk: "#eee" };
  await inUiLang("en", () => {
    assert.match(new ClientError("timeout", "client.error.timeout", { s: 5 }).message, /timed out.*5 seconds/);
    assert.equal(new URL(terminalPageUrl("http://x", "", "s1", "j1", C, t.lang)).searchParams.get("lang"), "en");
  });
  assert.match(new ClientError("timeout", "client.error.timeout", { s: 5 }).message, /超时/);
  assert.equal(new URL(terminalPageUrl("http://x", "", "s1", "j1", C, t.lang)).searchParams.get("lang"), "zh-CN");
  assert.equal(new URL(terminalPageUrl("http://x", "", "s1", "j1", C)).searchParams.get("lang"), null);
});
