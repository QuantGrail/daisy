/**
 * P6-28 (ADR-159 addendum): the names Daisy gives things itself — this
 * machine's node, the home workspace, each harness's host-login identity —
 * follow the reader's language. They are stored unnamed (an empty label;
 * an owner's own name has at least one character) and said through the
 * packs when shown; a name the owner typed is shown as typed.
 *
 * The server answers every label already in the request's language and
 * marks a default one (`labelDefault: true`), so a reader that keeps the
 * row (the web UI) can say it again in a language picked later
 * (`shownName`). Browser-safe.
 */
import type { Translate } from "./i18n.ts";

/** What kind of thing a default name names. */
export type DefaultNameKind = "node" | "workspace" | "profile";

/** The pack key of each kind's default name (`{agent}`: the harness). */
export const DEFAULT_NAME_KEYS = {
  node: "common-contracts.defaultName.node",
  workspace: "common-contracts.defaultName.homeWorkspace",
  profile: "common-contracts.defaultName.hostLogin",
} as const;

/** A kind's default name in the translator's language. */
export function defaultName(kind: DefaultNameKind, t: Translate, agent = ""): string {
  return kind === "profile" ? t(DEFAULT_NAME_KEYS.profile, { agent }) : t(DEFAULT_NAME_KEYS[kind]);
}

/** A row with a name as the local API answers it. */
export interface Named {
  label: string;
  /** The name is Daisy's own default (shown in the reader's language). */
  labelDefault?: boolean;
  /** A profile's harness (the host-login name says it). */
  agent?: string;
}

/** The name to show: a default one in `t`'s language, an owner's as typed. */
export function shownName(kind: DefaultNameKind, x: Named, t: Translate): string {
  return x.labelDefault || !x.label ? defaultName(kind, t, x.agent ?? "") : x.label;
}

/**
 * The identity chip's text: name · sign-in state. Daisy's default name for a
 * host-login identity already says "host login", so the state is not repeated.
 */
export function identityChipText(
  name: string,
  p: { label?: string; labelDefault?: boolean; configDir?: string; authMode?: string },
  state: string,
): string {
  const hostDefault = (p.labelDefault || !p.label) && !p.configDir && p.authMode !== "apiKey";
  return hostDefault ? name : `${name} · ${state}`;
}
