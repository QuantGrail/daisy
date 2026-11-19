/**
 * P4-12 (ADR-132): the words of the 「对外」 pages — the three kinds of
 * agent, a call card's waiting count and its callers, the resident
 * agent's isolation caveat (ADR-126 decision 8) — kept apart from the
 * components so the command line's docs and the tests read the same.
 */
import type {
  AgentOverview,
  InvokeRequest,
  ResidentAgentView,
  VisitorToken,
} from "@daisy-ai/contracts";
import { t } from "./i18n";

/** 5.2: what each kind is, one line each. */
export const agentKinds = (): { kind: "private" | "public" | "resident"; title: string; line: string }[] =>
  (["private", "public", "resident"] as const).map((kind) => ({
    kind,
    title: t.dynamic(`ui-sharing.kind.${kind}.title`),
    line: t.dynamic(`ui-sharing.kind.${kind}.line`),
  }));

/** A call card's line under the caller: how many calls wait on it, from how many AIs (P4-03 review M-3). */
export function waitingLine(r: Pick<InvokeRequest, "waiting" | "calls" | "actors">): string {
  const ais = r.actors.length;
  const from = ais
    ? t("ui-sharing.waiting.from", { count: ais, actors: r.actors.join(t("ui-sharing.sep")) })
    : t("ui-sharing.waiting.fromUnknown");
  return r.calls > r.waiting
    ? t("ui-sharing.waiting.lineWithTotal", { waiting: r.waiting, calls: r.calls, from })
    : t("ui-sharing.waiting.line", { waiting: r.waiting, from });
}

/** Who calls, with the external issuer marked (P4-03 review L-3: the name already says 「（外部签发方）」). */
export function callerLine(c: Pick<InvokeRequest["caller"], "name" | "issuer" | "contactId">): string {
  if (c.issuer) return t("ui-sharing.caller.issuer", { name: c.name, issuer: c.issuer });
  if (!c.contactId) return `${c.name}`;
  return t("ui-sharing.caller.contact", { name: c.name });
}

/** 5.6: the three choices, with what each does. */
export const decisions = (): { key: "always" | "once" | "reject"; label: string; hint: string }[] =>
  (["always", "once", "reject"] as const).map((key) => ({
    key,
    label: t.dynamic(`ui-sharing.decision.${key}.label`),
    hint: t.dynamic(`ui-sharing.decision.${key}.hint`),
  }));

export function agentKindLabel(a: Pick<AgentOverview, "kind" | "state">): string {
  if (a.kind === "public") return t("ui-sharing.kind.public.title");
  return a.state === "paused"
    ? t("ui-sharing.kind.resident.paused")
    : a.state === "closed"
      ? t("ui-sharing.kind.resident.closed")
      : t("ui-sharing.kind.resident.title");
}

export function rangeLabel(a: Pick<AgentOverview, "openTo" | "listed">): string {
  return a.openTo === "all" ? t("ui-sharing.range.all") : t("ui-sharing.range.listed", { count: a.listed });
}

/** ADR-126 decision 8: shown when a resident may run Bash (its tools unlimited, `*`, or Bash named). */
export function bashAllowed(r: Pick<ResidentAgentView, "tools" | "harness">): boolean {
  if (r.tools === null) return true;
  return r.tools.some((t) => t === "*" || /^Bash(\(|$)/.test(t));
}
export const isolationCaveat = (): string => t("ui-sharing.isolationCaveat");

export function tokenForLabel(v: Pick<VisitorToken, "for">): string {
  return v.for.kind === "me" ? t("ui-sharing.token.forMe") : v.for.name;
}
export function tokenStateLabel(v: Pick<VisitorToken, "state" | "revokedWhy">): string {
  if (v.state === "active") return t("ui-sharing.token.state.active");
  if (v.state === "expired") return t("ui-sharing.token.state.expired");
  return v.revokedWhy === "contact_removed"
    ? t("ui-sharing.token.state.contactRemoved")
    : v.revokedWhy === "pin_reset"
      ? t("ui-sharing.token.state.pinReset")
      : t("ui-sharing.token.state.revoked");
}

/** `daisy token` lifetimes offered on the page (token.md §5: default 7 days, at most 90). */
export const tokenTtls = (): { value: string; label: string }[] =>
  (["1d", "7d", "30d", "90d"] as const).map((value) => ({ value, label: t.dynamic(`ui-sharing.token.ttl.${value}`) }));

/** A group-of-four identity number for people to compare (identity-card.md §3). */
export function grouped(id: string): string {
  return id.replace(/\s+/g, "").replace(/(.{4})(?=.)/g, "$1 ");
}
