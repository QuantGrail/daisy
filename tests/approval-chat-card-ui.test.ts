// D-39 (2026-11-17): a harness permission
// prompt is answered in the conversation's card too — its option buttons
// show there (before: read-only 「去审批页处理」), the 「审批」 page link stays
// as a secondary link, and a click goes through the inbox's own route
// (`POST /api/approvals/perm:<id>/respond`). The card is bundled with
// react-native → react-native-web and rendered statically (as
// the old wake-approval-ui test, on tag baseline/pre-daisy); what a click calls is checked
// on the source, the round trip in tests/approval-inbox.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { uiMessages } from "./ui-pack.ts";

const root = path.resolve(import.meta.dirname, "..");
const esbuild = createRequire(import.meta.url)("esbuild");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "approval-card-ui-"));
const bundle = path.join(dir, "card.cjs");

const permission = {
  id: "perm-1",
  jobId: "j1",
  title: "Codex 命令",
  input: { command: "cat c1-approve.txt" },
  options: [
    { id: "accept", label: "允许本次" },
    { id: "native-1", label: "允许，以后不再问：cat c1-approve.txt" },
    { id: "decline", label: "拒绝" },
    { id: "cancel", label: "取消本轮" },
  ],
  category: "permission",
  reason: "需要读文件",
  status: "pending",
  createdAt: 1,
};
const question = {
  id: "q-1",
  jobId: "j1",
  title: "Codex 需要你的回答",
  input: { questions: [{ id: "branch", question: "哪个分支？" }] },
  options: [{ id: "submit", label: "提交回答" }],
  category: "question",
  status: "pending",
  createdAt: 1,
};

const harness = `
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApprovalCard } from "./packages/ui/src/chat";
import { DaisyHostProvider } from "./packages/ui/src/host";
import { setUiPack } from "./packages/ui/src/i18n";
const client = {
  respondApproval: () => Promise.resolve({}),
  approve: () => Promise.resolve({}),
};
const noop = () => {};
const adapters = { openApprovals: noop };
const card = (approval, withInbox) =>
  renderToStaticMarkup(
    React.createElement(
      DaisyHostProvider,
      withInbox ? { adapters } : {},
      React.createElement(ApprovalCard, { approval, client, sid: "s1", onError: noop }),
    ),
  );
// P6-22: the UI speaks the pack it is given (Chinese, then English).
setUiPack("en", ${JSON.stringify(uiMessages("en"))});
const english = card(${JSON.stringify(permission)}, true);
setUiPack("zh-CN", ${JSON.stringify(uiMessages("zh-CN"))});
process.stdout.write(JSON.stringify({
  permission: card(${JSON.stringify(permission)}, true),
  permissionNoInbox: card(${JSON.stringify(permission)}, false),
  question: card(${JSON.stringify(question)}, true),
  english,
}));
`;
await esbuild.build({
  absWorkingDir: root,
  stdin: {
    contents: harness,
    resolveDir: root,
    loader: "tsx",
    sourcefile: "card-harness.tsx",
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: bundle,
  alias: {
    "react-native": "react-native-web",
    "@daisy-ai/client": path.join(root, "packages/client/src/index.ts"),
    "@daisy-ai/contracts": path.join(root, "packages/contracts/src/index.ts"),
  },
  resolveExtensions: [".web.tsx", ".web.ts", ".web.js", ".tsx", ".ts", ".js"],
  define: { "process.env.NODE_ENV": '"production"', __DEV__: "false" },
  jsx: "automatic",
  loader: { ".js": "jsx", ".png": "dataurl", ".ttf": "dataurl" },
  logLevel: "error",
});
const out = JSON.parse(
  execFileSync(process.execPath, [bundle], { maxBuffer: 64 << 20 }).toString(),
);
fs.rmSync(dir, { recursive: true, force: true });
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

test("a permission card in the chat shows its answers, the reason and a secondary 「审批」 link", () => {
  const t = text(out.permission);
  for (const w of [
    "允许本次",
    "允许，以后不再问：cat c1-approve.txt",
    "拒绝",
    "取消本轮",
    "需要读文件",
    "在审批页查看",
  ])
    assert.ok(t.includes(w), w);
  assert.match(out.permission, /data-testid="approval-open-inbox"/);
  assert.doesNotMatch(out.permission, /data-testid="approval-elsewhere"/);
  assert.doesNotMatch(t, /去审批页处理/);
  // Without a 「审批」 page in the host: the answers alone.
  assert.ok(text(out.permissionNoInbox).includes("拒绝"));
  assert.doesNotMatch(out.permissionNoInbox, /approval-open-inbox/);
  // P6-22: in English the card's own words are English (the options are the harness's).
  const en = text(out.english);
  assert.ok(en.includes("View in Approvals"), en);
  assert.ok(en.includes("需要读文件"));
  assert.doesNotMatch(en, /在审批页查看|需要确认/);
});

test("a question card is unchanged: its input and 提交回答, no 「审批」 link", () => {
  const t = text(out.question);
  assert.ok(t.includes("哪个分支？") && t.includes("提交回答"), t);
  assert.doesNotMatch(out.question, /approval-open-inbox/);
});

test("the chat card decides a permission prompt through the inbox's route; questions stay on the conversation's", () => {
  const chat = fs.readFileSync(
    path.join(root, "packages/ui/src/chat.tsx"),
    "utf8",
  );
  assert.match(
    chat,
    /permission\s*\?\s*client\.respondApproval\("perm:" \+ a\.id, o\.id\)\s*:\s*client\.approve\(/,
  );
});
