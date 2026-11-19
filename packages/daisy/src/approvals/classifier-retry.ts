/**
 * 分类器不可用自动重试 (2026-11-08): auto mode refuses a tool call
 * when its safety classifier is temporarily unavailable (Claude Code's
 * `permission_denied` with decision_reason 「Classifier unavailable」, message
 * 「<model> is temporarily unavailable (…), so auto mode cannot determine the
 * safety of Bash right now. Wait a moment and then try this action again」).
 * That is not a judgement on the operation, so it gets no owner card: Daisy
 * wakes the AI to retry after a backoff. The retried call goes through the
 * classifier again — nothing is approved or bypassed here.
 */
import { ownerT } from "../platform/language.ts";
import type { Translate } from "../../../contracts/src/i18n.ts";

/** Backoff of the 1st, 2nd, 3rd consecutive round. */
export const CLASSIFIER_BACKOFF = [30_000, 60_000, 120_000];
/** Automatic retries per streak; the next round becomes one owner card. */
export const CLASSIFIER_MAX_RETRIES = CLASSIFIER_BACKOFF.length;
/** A streak with no classifier-unavailable refusal for this long resets. */
export const CLASSIFIER_WINDOW = 15 * 60_000;
/** Ops listed in one wake / card. */
export const CLASSIFIER_MAX_OPS = 10;

export type BlockedOp = {
  item: string;
  tool: string;
  reason: string;
  request: unknown;
};

/**
 * True when the refusal says the classifier could not decide (it was
 * unavailable), not that it judged the operation unsafe. Only fields Claude
 * Code fills with its own constants are trusted (review of 6bd10da, S1):
 * for a real denial `decision_reason` is the classifier model's rationale
 * (it can quote the transcript or the tool input) and `message` / `text`
 * embed it, so free-text matching there could be steered by the content
 * being judged. So: `reasonType` is "classifier" (or absent, older
 * Runners) AND `reason` is exactly 「Classifier unavailable」 (optionally
 * 「Blocked: 」-prefixed) — a whole-string match, so a rationale that
 * merely mentions those words does not qualify. `message` / `text` (e.g.
 * 「<model> is temporarily unavailable (…), so auto mode cannot determine
 * the safety of Bash…」, or a retry-after wording) are never consulted:
 * they vary, and for denials they carry the rationale. Hook / rule
 * refusals (other `reasonType`s) keep the card flow.
 */
const EXACT_REASON = /^(Blocked: )?Classifier unavailable$/i;
export function classifierUnavailable(item: any): boolean {
  const input = item?.input || {};
  const type = input.reasonType;
  // Codex's automatic review timed out — its own status enum
  // (`review.status`), set by the Runner, never review / model text.
  if (type === "auto_review") return input.reviewStatus === "timedOut";
  if (type && type !== "classifier") return false;
  return EXACT_REASON.test(String(input.reason ?? "").trim());
}

const flat = (s: unknown, n: number) =>
  String(s ?? "")
    .replace(/[<>【】]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, n);
/** Escape tags so model-controlled input cannot leave its fence. */
const clean = (x: string) =>
  x.replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
const opLine = (t: Translate) => (o: BlockedOp, i: number) => {
  const req =
    o.request == null
      ? ""
      : t("server-approvals.ops.lineSeparator") + clean(JSON.stringify(o.request).slice(0, 600));
  return `${i + 1}. ${flat(o.tool, 100) || t("server-approvals.tool")}${req}`;
};
const shown = (ops: BlockedOp[]) => ops.slice(-CLASSIFIER_MAX_OPS);
const more = (ops: BlockedOp[], t: Translate) =>
  ops.length > CLASSIFIER_MAX_OPS
    ? t("server-approvals.ops.more", { n: ops.length - CLASSIFIER_MAX_OPS })
    : "";
/**
 * The operations for a prompt: the tool input is the AI's own (model
 * controlled), so it sits inside <external_message>, tags escaped.
 */
export function opList(ops: BlockedOp[], t: Translate = ownerT()) {
  return `${t("server-approvals.ops.listIntro")}
<external_message>
${shown(ops).map(opLine(t)).join("\n")}
</external_message>${more(ops, t) ? "\n" + more(ops, t) : ""}`;
}
/**
 * model-made text (a refusal's rationale, a tool's arguments) for a
 * wake: fenced, tags escaped, said to be material, not anyone's words.
 */
export function fenced(what: string, text: string, n = 1500, t: Translate = ownerT()) {
  return `${t("server-approvals.fenced.intro", { what })}
<external_message>
${clean(String(text ?? "").slice(0, n))}
</external_message>`;
}
/** A plain summary for the owner's card: what a retry would retry. */
export function opSummary(ops: BlockedOp[], t: Translate = ownerT()) {
  return (
    shown(ops)
      .map(
        (o, i) =>
          `${i + 1}. ${flat(o.tool, 100) || t("server-approvals.tool")}${o.request == null ? "" : t("server-approvals.ops.lineSeparator") + flat(JSON.stringify(o.request), 300)}`,
      )
      .join("\n") + (more(ops, t) ? "\n" + more(ops, t) : "")
  );
}

/**
 * The retry wake. A Daisy event, not anyone's decision: it says nobody
 * approved the operations, and the retry is checked by auto mode again.
 */
export function retryPrompt(ops: BlockedOp[], round: number, t: Translate = ownerT()) {
  return t("server-approvals.wake.classifierRetry", {
    n: ops.length,
    ops: opList(ops, t),
    round,
    max: CLASSIFIER_MAX_RETRIES,
  });
}
