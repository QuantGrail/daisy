/**
 * P4-01 (5.4 「被别的智能体调用」 step 2, 5.6, D-15, T-2, T-10, ADR-120):
 * the part of "may this caller call this agent" that recognition and the
 * whitelist decide, before any card exists.
 *
 *   not recognised (no valid token, a stranger, a removed contact)  → refused, no card (T-2)
 *   a private agent                                                → refused, no card
 *   an agent open to listed people only: listed → allowed; else    → refused, no card (T-3)
 *   an agent open to all contacts: whitelisted → allowed, no card (T-10); else → ask the owner
 *
 * `ask_owner` is where P4-03 raises the card (永久通过 / 仅本次 / 拒绝, 7
 * days) and checks the per-agent × per-person grants first; P4-04's A2A
 * server calls this with the guard's principal and the target agent's
 * openness. Every answer reads the address book afresh, so removing a
 * contact or taking them off the whitelist holds from the next call.
 */
import type { Principal } from "../access/guard.ts";
import type { Contacts } from "./index.ts";

/** 5.2 开放范围 (a private agent is never callable). */
export type AgentOpenness =
  | { openTo: "private" }
  | { openTo: "all" }
  | { openTo: "listed"; listed: readonly string[] };

export type Admission =
  | { outcome: "refused"; reason: "not_recognised" | "agent_private" | "not_listed" }
  | { outcome: "allowed"; via: "whitelist" | "listed"; contactId: string }
  | { outcome: "ask_owner"; contactId: string | null; subject: string };

export function admit(p: Principal | null | undefined, agent: AgentOpenness, contacts: Contacts): Admission {
  if (!p || p.kind !== "visitor" || !p.subject) return { outcome: "refused", reason: "not_recognised" };
  // A contact: still in the address book now (the principal may be from a
  // request that started before a removal).
  const contact = p.contactId ? contacts.get(p.contactId) : null;
  if (p.contactId && !contact) return { outcome: "refused", reason: "not_recognised" };
  if (agent.openTo === "private") return { outcome: "refused", reason: "agent_private" };
  const who = contact?.id ?? null;
  if (agent.openTo === "listed")
    return who && agent.listed.includes(who)
      ? { outcome: "allowed", via: "listed", contactId: who }
      : { outcome: "refused", reason: "not_listed" };
  if (contact?.whitelisted) return { outcome: "allowed", via: "whitelist", contactId: contact.id };
  // Recognised but not pre-approved: the owner decides (P4-03's card).
  // An external issuer's visitor (D-08) lands here too: no whitelist there.
  return { outcome: "ask_owner", contactId: who, subject: p.subject };
}
