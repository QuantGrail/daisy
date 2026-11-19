/**
 * How people see an AI named next to others: cards, notifications
 * (2026-11-01: 「AI 的名字在开头就需要标明是谁的 AI」). One rule
 * everywhere, the viewer's own AIs included:
 *
 *   「<owner username> 的 AI · <session title>」, e.g. 「alice 的 AI · GRM 数据」
 *   「<owner username> 的 AI」 when the title is empty or says nothing.
 *
 * The owner is always the server's (the session's owner → users.username),
 * never read from the title, and always comes first: bob's AI titled
 * 「alice 的 AI」 reads 「bob 的 AI · alice 的 AI」.
 *
 * Prompts injected into AIs keep their own wording (「alice 的 AI「…」」,
 * source-prompt.ts): also owner first, with the title quoted.
 */
import type { Translate } from "./i18n.ts";
import { defaultTranslate } from "./i18n-default.ts";

export interface AgentLabelInput {
  /** The session title (any text its owner or its AI chose). */
  title?: string | null;
  /** The owner's username, from server data. */
  ownerName?: string | null;
}

/**
 * Placeholder title of a session that no longer exists, in `t`'s language.
 * A stored one in any shipped language is recognised (`isDeletedTitle`).
 */
export const deletedAgentTitle = (t: Translate = defaultTranslate()) => t("ui-contracts.agent.deleted");

/**
 * Titles that say nothing beyond "an AI": the label is the owner's alone.
 * They are stored data (placeholders written by older versions and by
 * other languages), so the list (`ui-contracts.agent.genericTitles`,
 * `|`-separated) names every language's placeholders, not just `t`'s.
 */
const genericTitles = (t: Translate) =>
  new Set(t("ui-contracts.agent.genericTitles").split("|").map((x) => x.trim().toLowerCase()).filter(Boolean));
/** A stored "deleted AI" placeholder (`ui-contracts.agent.deletedTitles` lists every language's). */
export const isDeletedTitle = (title: unknown, t: Translate = defaultTranslate()) => {
  const x = flat(title).toLowerCase();
  return !!x && t("ui-contracts.agent.deletedTitles").split("|").some((d) => d.trim().toLowerCase() === x);
};

/** One line, single spaces. */
const flat = (s: unknown) =>
  String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();

/** 「alice 的 AI」; 「AI」 when the owner is unknown. */
export function agentOwnerLabel(ownerName?: string | null, t: Translate = defaultTranslate()) {
  const owner = flat(ownerName);
  return owner ? t("ui-contracts.agent.owner", { owner }) : t("ui-contracts.agent.anonymous");
}

/**
 * The title as shown after the owner, or "" when it adds nothing (empty, a
 * placeholder, or exactly 「<its own owner> 的 AI」 in any language).
 */
export function agentTitle({ title, ownerName }: AgentLabelInput, t: Translate = defaultTranslate()) {
  const x = flat(title);
  const key = x.toLowerCase();
  if (!x || genericTitles(t).has(key)) return "";
  if (key === agentOwnerLabel(ownerName, t).toLowerCase()) return "";
  return x;
}

/** 「alice 的 AI · GRM 数据」 / 「alice 的 AI」 (see above). */
export function agentLabel(input: AgentLabelInput, t: Translate = defaultTranslate()) {
  const head = agentOwnerLabel(input.ownerName, t);
  if (isDeletedTitle(input.title, t))
    return flat(input.ownerName) ? t("ui-contracts.agent.ownerDeleted", { owner: head }) : deletedAgentTitle(t);
  const x = agentTitle(input, t);
  return x ? t("ui-contracts.agent.labelWithTitle", { owner: head, title: x }) : head;
}
