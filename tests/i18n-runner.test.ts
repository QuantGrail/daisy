/**
 * P6-23b (ADR-159): the Runner's words (harness/**, turns/**) come from
 * the language packs — the owner's language (here `DAISY_LANG`), or the
 * session's when it has one (`turnT(lang)`). The other tests run in
 * zh-CN (tests/test-env.mjs) and keep the Chinese texts; these check the
 * English ones and that stored text is recognized in every language.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { codexDecisionLabel } from "../packages/daisy/src/harness/codex.ts";
import { modelSwitchItem } from "../packages/daisy/src/harness/model-switch.ts";
import { AUTH_MESSAGES, claudeAuthMessage } from "../packages/daisy/src/harness/claude-auth.ts";
import { reviewInterception } from "../packages/daisy/src/harness/codex-review.ts";
import { textsOf } from "../packages/daisy/src/harness/shared.ts";
import { conflictMessage, unrestorableMessage } from "../packages/daisy/src/turns/file-checkpoints.ts";
import { otherIdentityBusy, retireReason } from "../packages/daisy/src/turns/live.ts";
import { sidecarToolRefusal } from "../packages/daisy/src/turns/sidecar.ts";
import { turnT } from "../packages/daisy/src/harness/model-switch.ts";

/** Run `f` with the owner's language set to `lang` (the server's `DAISY_LANG`). */
function inLang<T>(lang: string, f: () => T): T {
  const was = process.env.DAISY_LANG;
  process.env.DAISY_LANG = lang;
  try {
    return f();
  } finally {
    if (was === undefined) delete process.env.DAISY_LANG;
    else process.env.DAISY_LANG = was;
  }
}

test("Runner words: approval option labels and notices follow the owner's language", () => {
  assert.equal(inLang("en", () => codexDecisionLabel("acceptForSession")), "Allow for this session");
  assert.equal(inLang("zh-CN", () => codexDecisionLabel("acceptForSession")), "允许此会话");
  assert.match(
    inLang("en", () =>
      codexDecisionLabel({ applyNetworkPolicyAmendment: { network_policy_amendment: { host: "example.org", action: "deny" } } }),
    ),
    /^Deny, and block network access: example\.org$/,
  );
  assert.equal(inLang("en", () => retireReason()).includes("Identity switched"), true);
  assert.match(inLang("en", () => otherIdentityBusy()), /old identity's AI process is still running/);
  assert.match(inLang("en", () => AUTH_MESSAGES.notLoggedIn), /not signed in/);
  assert.match(inLang("en", () => claudeAuthMessage({ kind: "missing", code: "ENOENT" } as any)), /^Starting Claude Code failed \(ENOENT\)/);
  // No Chinese left in an English owner's Runner text.
  for (const s of inLang("en", () => [AUTH_MESSAGES.keychain, AUTH_MESSAGES.keychainSuspect, retireReason()]))
    assert.doesNotMatch(s, /[一-鿿]/, s);
});

test("Runner words: a model switch and a review denial are whole English sentences", () => {
  const item = inLang("en", () =>
    modelSwitchItem({ from: "a", to: "b", reason: "x", session: true, engine: "claude", code: "refusal" }),
  );
  assert.equal(item.name, "Model changed this turn");
  assert.match(String(item.text), /^x: this turn and later ones are answered by b \(the session chose a\), and the session's model is now this one$/);
  const zh = inLang("zh-CN", () =>
    modelSwitchItem({ from: "a", to: "b", reason: "x", session: false, engine: "claude", code: "refusal" }),
  );
  assert.equal(zh.text, "x：这一轮由 b 回答（会话选的是 a）");
  const denied = inLang("en", () =>
    reviewInterception(
      { reviewId: "r1", review: { status: "denied", riskLevel: "low", userAuthorization: "low", rationale: "no" } },
      "t",
    ),
  );
  assert.match(String(denied?.item.text), /^Codex's automatic review denied this action \(risk: low, authorization: low\): no$/);
});

test("Runner words: list separators and refusals of a rewind are per language", () => {
  const plan: any = { missing: [], conflicts: [{ path: "a.ts" }, { path: "b.ts" }], unrestorable: [{ path: "c.ts", why: "symlink" }], restore: [] };
  assert.match(inLang("en", () => conflictMessage(plan)), /^2 file\(s\) were changed again after the AI changed them: a\.ts, b\.ts\./);
  assert.match(inLang("zh-CN", () => conflictMessage(plan)), /^有 2 个文件在 AI 改过之后又被改动：a\.ts、b\.ts。/);
  assert.match(inLang("en", () => unrestorableMessage(plan)), /c\.ts \(a symbolic link\)/);
});

test("Runner words: a session's own language wins over the owner's", () => {
  const owner = inLang("zh-CN", () => sidecarToolRefusal());
  const session = inLang("zh-CN", () => sidecarToolRefusal("en"));
  assert.match(owner, /只问支线里不能用/);
  assert.match(session, /cannot be used in an ask-only side thread/);
  assert.equal(inLang("zh-CN", () => turnT("en").lang), "en");
  // An unknown session language falls back to the owner's.
  assert.equal(inLang("zh-CN", () => turnT("xx").lang), "zh-CN");
});

test("Runner words: stored names are recognized in every language (old Chinese included)", () => {
  const names = textsOf("server-harness.item.subagentReply");
  assert.ok(names.has("子 Agent 回复"), "the old stored Chinese form");
  assert.ok(names.has("Subagent reply"));
  const masks = textsOf("server-turns.config.mask");
  assert.ok(masks.has("[保留原密钥]") && masks.has("[keep the existing secret]"));
});
