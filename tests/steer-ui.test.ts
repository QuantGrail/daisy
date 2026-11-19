/**
 * The trace bar counts only real steps, keeps the running
 * turn when a queued message is removed, and 「插队发送」 asks first when
 * it would stop running subagents.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  currentTurnIndex,
  groupTurns,
  isStep,
  stepLine,
} from "../packages/ui/src/present.ts";
import { uiLang, uiMessages } from "./ui-pack.ts";

// P6-22 (ADR-159 §8): the UI speaks Chinese here (the assertions are Chinese).
uiLang("zh-CN");

const A = "11111111-1111-4111-8111-111111111111",
  B = "22222222-2222-4222-8222-222222222222";
const item = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, kind: "tool", status: "complete", createdAt: 1, ...extra }) as any;

test("「完成 N 个步骤」 counts the Agent's steps, not stages, usage, hooks or notices", () => {
  const turn = [
    item(`${A}:stage:claimed`, {
      category: "lifecycle",
      name: "执行节点已接单",
    }),
    item(`${A}:stage:launch`, { category: "lifecycle", name: "沿用在线进程" }),
    item(`${A}:usage`, { category: "usage", name: "本轮用量" }),
    item(`${A}:system:hook_response`, {
      category: "native",
      name: "hook_response",
    }),
    item(`${A}:context`, { category: "context" }),
    item(`${A}:notice`, { kind: "notice" }),
  ];
  assert.equal(turn.filter(isStep).length, 0, "a zero-work turn has no steps");
  const real = [
    ...turn,
    item(`${A}:t1`, { name: "Bash", input: { command: "ls" } }),
    item(`${A}:task:sub-1`, { category: "subagent", name: "长任务" }),
  ];
  assert.equal(real.filter(isStep).length, 2);
  assert.match(stepLine(real.filter(isStep), 10), /^第 2 步完成/);
  // activity.tsx counts with the same rule.
  const src = readFileSync("packages/ui/src/activity.tsx", "utf8");
  assert.match(src, /steps = items\.filter\(isStep\)/);
  assert.match(src, /traceSummarySteps, \{ count: steps\.length \}/);
  assert.match(src, /traceProgress, \{ done, total: steps\.length \}/);
});

test("removing a queued message keeps the trace on the running turn (no 「正在准备…」)", () => {
  const items = [
    item(`user:${A}`, { kind: "user", status: "accepted" }),
    item(`${A}:t1`),
    item(`user:${B}`, { kind: "user", status: "queued" }),
    item(`${A}:t2`, { status: "running" }),
  ];
  const view = (waiting: (id: string) => boolean) => {
    const turns = groupTurns(items, waiting);
    return turns[currentTurnIndex(turns, waiting)][0].id;
  };
  // Removed, the queue already re-read, its 「已取消」 item not yet here:
  // the old rule pointed at B's empty turn.
  assert.equal(
    view(() => false),
    `user:${B}`,
  );
  // the removed id stays "not started" locally.
  const removed = new Set([`user:${B}`]);
  assert.equal(
    view((id) => removed.has(id)),
    `user:${A}`,
  );
  const chat = readFileSync("packages/ui/src/chat.tsx", "utf8");
  assert.match(
    chat,
    /removedItems\.current\.add\(`user:\$\{(q\.id|jid)\}`\);\s*removedItems\.current\.add\(`wake:\$\{(q\.id|jid)\}`\);\s*setQueued/,
  );
  assert.match(chat, /removedItems\.current\.has\(id\)/);
});

test("「插队发送」 with running subagents asks first: 「本轮结束后发送」 / 「仍然插队」", () => {
  // P6-22: the default copy is the language pack's (`ui-copy.*`).
  const zh = uiMessages("zh-CN"),
    en = uiMessages("en");
  assert.equal(zh["ui-copy.jumpAfterTurn"], "本轮结束后发送");
  assert.equal(zh["ui-copy.jumpAnyway"], "仍然插队");
  assert.match(zh["ui-copy.jumpSubagentsWarning"]!, /将中断正在运行的 \{count\} 个子 Agent/);
  assert.equal(zh["ui-copy.userStatusRequeued"], "已改为下一轮发送");
  assert.equal(en["ui-copy.jumpAnyway"], "Jump anyway");
  // P6-28: a plural choice (one subagent / # subagents).
  assert.match(en["ui-copy.jumpSubagentsWarning"]!, /\{count, plural, one \{This stops # running subagent:.*other \{This stops # running subagents:/);
  const chat = readFileSync("packages/ui/src/chat.tsx", "utf8");
  assert.match(chat, /runningSubagents \?\? 0/);
  assert.match(chat, /testID="jump-subagents-later"/);
  assert.match(chat, /jumpQueued\(jumpWarn\.jid, true\)/);
});
