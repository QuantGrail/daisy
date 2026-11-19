// Files dropped anywhere on an AI conversation (packages/ui/src/
// chat-drop.web.ts; P1-01 kept the session part of the chat page's drop
// rules): one overlay key per distinct target.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dropKey } from "../packages/ui/src/chat-drop.web.ts";

test("each target's overlay key: the session's title, note and readiness; none by its hint", () => {
  assert.equal(
    dropKey({ kind: "session", title: "数据核对" }, true),
    "session:数据核对::1",
  );
  assert.equal(
    dropKey({ kind: "session", title: "数据核对", note: "已有 2 个" }, false),
    "session:数据核对:已有 2 个:0",
  );
  assert.equal(dropKey({ kind: "none", hint: null }, true), "none:");
  assert.equal(dropKey({ kind: "none", hint: "拖到对话里" }, false), "none:拖到对话里");
});
