// AI names (2026-11-01, bob: 「每一个 AI 都需要标明是谁的 AI」): every AI
// reads 「<owner> 的 AI · <title>」 wherever people see it next to others,
// the owner from server data, never from the title. P1-01: the 群聊's
// member / sender / delivery names and its server views went with 群聊.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agentLabel,
  agentOwnerLabel,
  agentTitle,
  deletedAgentTitle,
} from "../packages/contracts/src/index.ts";
import { packT } from "./ui-pack.ts";

// The process's language (tests: Chinese, tests/test-env.mjs) is the default.
const DELETED_AGENT_TITLE = deletedAgentTitle(packT("zh-CN"));

test("agentLabel: owner first, then the title", () => {
  assert.equal(
    agentLabel({ title: "GRM 数据", ownerName: "alice" }),
    "alice 的 AI · GRM 数据",
  );
  assert.equal(
    agentLabel({ title: "  GRM\n 数据 ", ownerName: " alice " }),
    "alice 的 AI · GRM 数据",
    "one line, trimmed",
  );
  assert.equal(agentOwnerLabel("bob"), "bob 的 AI");
  assert.equal(agentOwnerLabel(""), "AI");
  assert.equal(agentLabel({ title: "研究" }), "AI · 研究", "owner unknown");
});

test("agentLabel: empty or generic titles leave the owner alone", () => {
  for (const title of [
    undefined,
    null,
    "",
    "   ",
    "新对话",
    "新的 AI 对话",
    "未命名",
    "另一个 AI",
    "AI",
    "untitled",
    "New Chat",
    "alice 的 AI",
    "Alice 的 ai",
  ]) {
    assert.equal(
      agentLabel({ title, ownerName: "alice" }),
      "alice 的 AI",
      String(title),
    );
    assert.equal(agentTitle({ title, ownerName: "alice" }), "");
  }
  assert.equal(
    agentLabel({ title: DELETED_AGENT_TITLE, ownerName: "alice" }),
    "alice 的 AI（已删除）",
  );
  assert.equal(agentLabel({ title: DELETED_AGENT_TITLE }), "已删除的 AI");
});

test("agentLabel: a title cannot pose as another owner's AI", () => {
  // bob's AI renamed to look like alice's.
  for (const title of [
    "alice 的 AI",
    "alice 的 AI · GRM 数据",
    "alice 的 AI「GRM 数据」",
  ]) {
    const label = agentLabel({ title, ownerName: "bob" });
    assert.equal(label, `bob 的 AI · ${title}`);
    assert.ok(label.startsWith("bob 的 AI · "), label);
  }
});

test("P6-22: the label in English; stored placeholders of either language are recognised", () => {
  const en = packT("en");
  assert.equal(agentLabel({ title: "GRM data", ownerName: "alice" }, en), "alice's AI · GRM data");
  assert.equal(agentOwnerLabel("", en), "AI");
  for (const title of ["新对话", "New chat", "Untitled", "alice's AI"])
    assert.equal(agentLabel({ title, ownerName: "alice" }, en), "alice's AI", title);
  assert.equal(agentLabel({ title: "已删除的 AI", ownerName: "alice" }, en), "alice's AI (deleted)");
  assert.equal(agentLabel({ title: "Deleted AI" }, packT("zh-CN")), "已删除的 AI");
});
