/**
 * P6-28 (ADR-159 addendum): Daisy's own names — this machine's node, the
 * home workspace, each harness's host-login identity — are stored unnamed
 * (an empty label) and said in the reader's language when shown.
 *
 * Rows written before P6-28 hold the name rendered in the language of the
 * first start ("本机", "用户主目录", "codex · 主机登录", or the English
 * ones). A label that equals a default name in ANY language present is
 * read as unnamed too (read-time normalisation: no schema step, the row
 * is left as it is — an older Daisy still reads it). An owner's own name
 * that happens to be spelled exactly like a default is read as the
 * default, which shows the same words in that language.
 */
import { DEFAULT_NAME_KEYS, defaultName, type DefaultNameKind } from "../../../contracts/src/default-names.ts";
import { translator, type Translate } from "../../../contracts/src/i18n.ts";
import { packsFor } from "../../../contracts/src/i18n-node.ts";
import { currentOwnerDataDir, ownerT } from "./language.ts";

/** A kind's default name in every language present (each once). */
export function defaultNameForms(kind: DefaultNameKind, agent = ""): Set<string> {
  const packs = packsFor(currentOwnerDataDir());
  return new Set(Object.keys(packs).map((l) => translator(packs, l).dynamic(DEFAULT_NAME_KEYS[kind], { agent })));
}

/** Whether a stored label is Daisy's default name (unnamed, or a default in any language). */
export function isDefaultName(kind: DefaultNameKind, label: unknown, agent = ""): boolean {
  if (typeof label !== "string" || label === "") return true;
  return defaultNameForms(kind, agent).has(label);
}

/**
 * A stored label as a reader sees it: a default name in `t`'s language
 * with `labelDefault: true`; an owner's name as typed.
 */
export function namedFor(
  kind: DefaultNameKind,
  label: unknown,
  t: Translate = ownerT(),
  agent = "",
): { label: string; labelDefault?: true } {
  return isDefaultName(kind, label, agent) ? { label: defaultName(kind, t, agent), labelDefault: true } : { label: String(label) };
}

/** Just the name (`namedFor` without the flag). */
export const nameFor = (kind: DefaultNameKind, label: unknown, t: Translate = ownerT(), agent = ""): string =>
  namedFor(kind, label, t, agent).label;
