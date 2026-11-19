/**
 * P4-03 调用授权 (总纲 5.2 开放范围, 5.4 「被别的智能体调用」 step 2–3, 5.6,
 * 5.11 「外面来的」, D-15, D-19, T-1, T-3, T-4, T-5, ADR-122): may this
 * caller call this agent — and if the owner has to say, the card.
 *
 * Rebuilt from the old server's `invoke-access.ts` (group-bound: one card
 * per caller × AI × group, five choices, grants per group) with what stays
 * (开放范围, the card, the whitelist) and nothing of the group: one grant
 * per agent × person, three choices, seven days.
 *
 *   recognised?        no (no valid token, a stranger, a removed contact,
 *                      a person of an issuer no longer configured)            → refused, no card (T-2)
 *   the agent          unknown / private (one answer: agent_unknown)          → refused, no card (T-3)
 *   only listed people listed → allowed; anyone else                         → refused, no card (T-3)
 *   open to all        whitelisted (D-15) → allowed; a grant → allowed;
 *                      refused by the owner < 10 min ago → refused, no card;
 *                      too many cards / waiting calls → refused, no card;
 *                      else → a card (one per agent × person; later calls join it)
 *
 * The recognition / range rows are P4-01's `admit` (contacts/admission.ts),
 * plus: an external issuer's person is someone only while that issuer is
 * the configured one (review M-2). Every answer reads the database afresh.
 *
 * ── For P4-04 (the A2A server), ADR-122 §8 ─────────────────────────────
 *
 *   const d = invoke.check(principal, agentId);       // sync; may create / join a card
 *   d.outcome === "refused"  → TASK_STATE_REJECTED (d.reason, d.message); no card was made
 *   d.outcome === "pending"  → TASK_STATE_AUTH_REQUIRED; then
 *        const s = await invoke.wait(d, signal);       // this call's place on the card
 *        s.outcome === "refused" → REJECTED (s.reason, s.message)
 *   then (allowed, or s allowed):
 *        const h = invoke.begin(principal, agentId, { ticket: d.ticket, stop });
 *        // checks again, atomically, that it may start NOW (throws InvokeError 403
 *        // `not_admitted` otherwise); a 仅本次 ticket starts one call only.
 *        … h.end() when it finishes.
 *   `invoke.canSee(principal, agentId)`: may this caller read the agent card.
 *
 * Who stops calls, and when (5.6 「撤销时…会被停止」): revoking a grant, a
 * narrower range, taking someone off the whitelist, removing a contact,
 * removing / changing the external issuer, deleting an agent, resetting
 * the PIN — `recheck(filter)` re-asks for each call in progress whether it
 * would still get in without a card (a 仅本次 call stands until something
 * refuses it outright). P4-06 / P4-07 call `recheck({ agentId })` after
 * making an agent private or pausing it, `forgetAgent(id)` when one goes.
 *
 * Waiters are told how their card ended from inside the change that ended
 * it; if that change is then rolled back (another listener of the same
 * transaction threw), a waiter may have been told `canceled` for nothing —
 * it calls again and gets a fresh answer (review L-7, ADR-122 §5).
 *
 * Agents: whoever owns a kind of agent registers a resolver (`agents.add`):
 * P4-06 public sessions, P4-07 resident agents. createApp registers the
 * fallback — every session, private (nothing is callable until P4-06).
 */
import { createHash, randomUUID } from "node:crypto";
import { CARD_LIMITS } from "../../../contracts/src/limits.ts";
import {
  INVOKE_DECISIONS,
  type AgentAudience,
  type InvokeDecisionKey,
  type InvokeGrant,
  type InvokePerson,
  type InvokeRequest,
} from "../../../contracts/src/api/invoke.ts";
import type { Store } from "../store/index.ts";
import { HttpError, LocalizedError, type MsgParams } from "../app/errors.ts";
import type { MessageKey } from "../../../contracts/src/i18n.ts";
import { ownerT } from "../platform/language.ts";
import { id as newId } from "../store/index.ts";
import type { Principal } from "../access/guard.ts";
import { LABEL_MAX, UNSAFE_TEXT } from "../access/tokens/common.ts";
import type { Contacts } from "../contacts/index.ts";
import { admit, type Admission, type AgentOpenness } from "../contacts/admission.ts";
import { Calls, type ActiveCall, type CallFilter, type CallHandle, type CallVia, type StopReason } from "./calls.ts";

export { type ActiveCall, type CallFilter, type CallHandle, type CallVia, type StopReason } from "./calls.ts";

/** An agent others might call (5.2). */
export interface AgentInfo {
  id: string;
  kind: "private" | "public" | "resident";
  /** For people: the card's title. */
  name: string;
  /** The session behind it (a public agent), if any. */
  sessionId: string | null;
}
/** Who knows this agent id (null: not mine). */
export type AgentResolver = (agentId: string) => AgentInfo | null;

/**
 * Why a call is refused outright. A private agent reads as `agent_unknown`
 * to the caller (review L-6: nobody learns which private agents exist).
 */
export type InvokeRefusal =
  | "not_recognised"
  | "agent_unknown"
  | "not_listed"
  | "rejected_recently"
  | "too_many_waiting"
  | "too_many_requests";

export type InvokeCheck =
  | { outcome: "refused"; reason: InvokeRefusal; message: string }
  | { outcome: "allowed"; via: Exclude<CallVia, "once">; person: InvokePerson; agent: AgentInfo }
  | {
      outcome: "pending";
      /** `call:<uuid>` (the 「审批」 list and the event outlet use the same). */
      requestId: string;
      /** This call's place on the card: `wait` and `begin` take it. */
      ticket: string;
      /** This call raised the card (false: it joined one already waiting). */
      raised: boolean;
      person: InvokePerson;
      agent: AgentInfo;
    };

export type InvokeSettlement =
  | { outcome: "allowed"; via: CallVia }
  | { outcome: "refused"; reason: "rejected" | "expired" | "canceled"; message: string };

/** A card changed state (the notice, the event outlet). Called inside the change's transaction. */
export type CardListener = (
  state: InvokeRequest["status"],
  card: InvokeRequest,
  title: string,
) => void;

export class InvokeError extends Error {
  /** P6-23b: set by `InvokeError.of` — the message key, said per reader (routes: the request's language). */
  key?: MessageKey;
  params: MsgParams = {};
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
  /** An error by message key: `message` in the owner's language (what an A2A caller is told). */
  static of(status: number, code: string, key: MessageKey, params: MsgParams = {}): InvokeError {
    const e = new InvokeError(status, ownerT().dynamic(key, params), code);
    e.key = key;
    e.params = params;
    return e;
  }
  /** As an answer of the local API (said in the request's language when it has a key). */
  toHttp(): HttpError {
    return this.key ? new LocalizedError(this.status, this.code, this.key, this.params) : new HttpError(this.status, this.message, this.code);
  }
}

const PREFIX = "call:";
/** `call:<uuid>` or the bare uuid → the bare uuid. */
export const requestKey = (rid: string) => (rid.startsWith(PREFIX) ? rid.slice(PREFIX.length) : rid);

/** Why a caller is refused, said in the owner's language (a key per refusal). */
const refusedKey = (reason: string): MessageKey => `server-invoke.refused.${reason}` as MessageKey;
const REFUSED_TEXT = (reason: string): string => {
  const t = ownerT();
  return t.has(refusedKey(reason)) ? t.dynamic(refusedKey(reason)) : reason;
};
const SETTLED_WHY = (status: "rejected" | "expired" | "canceled"): string => ownerT().dynamic(`server-invoke.settled.${status}`);
/**
 * A card's `closed_why`: stored as a message key (P6-23b) and said when
 * read; a card closed before that keeps its stored sentence.
 */
/** A card's answer (永久通过 / 仅本次 / 拒绝, 5.6) in the owner's language; an unknown one as it is. */
const decisionLabel = (key: string): string => {
  const t = ownerT();
  return t.has(`server-approvals.call.option.${key}`) ? t.dynamic(`server-approvals.call.option.${key}`) : key;
};
const sayWhy = (why: string): string => {
  const t = ownerT();
  return t.has(why) ? t.dynamic(why) : why;
};

/**
 * Text the caller controls (a card's name, a token's `sub` / `act.sub`),
 * as it goes onto a card the owner reads: no control, bidi or zero-width
 * characters (P4-01 review M-2 refuses them in tokens already — this is
 * the second line), and bounded.
 */
const UNSAFE_ALL = new RegExp(UNSAFE_TEXT.source, "g");
export const shown = (s: unknown, max: number) => {
  const t = String(s ?? "").replace(UNSAFE_ALL, "").trim();
  return [...t].length > max ? [...t].slice(0, max - 1).join("") + "…" : t;
};
/** The longest name a card shows for a caller (identity-card.md: names are at most 64). */
const NAME_MAX = 64;
/** Review L-3: an external issuer's person, marked as such on cards. */
const externalMark = () => ownerT()("server-invoke.externalMark");

/** A person as stored on a card, a grant or a call. */
interface Who {
  key: string;
  contactId: string | null;
  issuer: string | null;
  subject: string;
}

/**
 * Review M-2 / L-1: an external issuer's person is the issuer and the whole
 * `sub` together — the same `sub` under another issuer, or two long subjects
 * that share their first 200 characters, are different people.
 */
/** P4-12: the owner, calling with a `daisy token --for me` (a visitor like anyone else). */
export const SELF_PERSON = "self";
const selfName = () => ownerT()("server-invoke.selfName");

export const issuerPersonKey = (issuer: string, subjectHash: string) =>
  "sub:" + createHash("sha256").update(`${issuer}\n${subjectHash}`).digest("base64url");

const rowPerson = (r: any): InvokePerson => ({
  key: r.person,
  contactId: r.contact_id ?? null,
  issuer: r.issuer ?? null,
  subject: r.subject,
  name: r.name,
});

const grantView = (r: any, agentName: string): InvokeGrant => ({
  id: r.id,
  agent: { id: r.agent_id, name: agentName },
  person: rowPerson(r),
  grantedAt: r.granted_at,
  requestId: r.request_id ? PREFIX + r.request_id : null,
});

export class InvokeAccess {
  private live = new Calls();
  /** The calls in progress (read only; `begin` adds, the revocations stop). */
  readonly calls: { list(f?: CallFilter): ActiveCall[]; readonly size: number } = ((live: Calls) => ({
    list: (f: CallFilter = {}) => live.list(f),
    get size() {
      return live.size;
    },
  }))(this.live);
  private resolvers: AgentResolver[] = [];
  /** ticket → resolve. */
  private waiters = new Map<string, (s: InvokeSettlement) => void>();
  private listeners: CardListener[] = [];
  private now: () => number;
  private issuerNow: () => string | null;

  /** Agents: a resolver per kind; the newest registered is asked first. */
  readonly agents = {
    add: (fn: AgentResolver) => void this.resolvers.unshift(fn),
    resolve: (agentId: string): AgentInfo | null => {
      for (const f of this.resolvers) {
        const a = f(agentId);
        if (a) return a;
      }
      return null;
    },
  };

  constructor(
    private store: Store,
    private contacts: Contacts,
    o: { now?: () => number; issuer?: () => string | null } = {},
  ) {
    this.now = o.now ?? Date.now;
    this.issuerNow = o.issuer ?? (() => null);
    // P4-01's seam: a removed contact's grants, named-list places and
    // cards go in the removal's transaction; their calls stop.
    contacts.onRemoved((c) => this.forget(c.id));
    // On / off the whitelist: calls that stood on it alone stop; cards
    // of someone now let in outright are settled (review L-5).
    contacts.onWhitelistChanged((c) => void this.recheck({ person: c.id }));
  }

  /** The notice / event outlet for cards (createApp). */
  onCard(fn: CardListener): void {
    this.listeners.push(fn);
  }

  // ── who and where ─────────────────────────────────────────────────────
  /** The person a principal is (null: not a visitor this Daisy recognises). */
  private personOf(p: Principal | null | undefined): (Who & { name: string }) | null {
    if (!p || p.kind !== "visitor" || !p.subject) return null;
    // P4-12 (token.md §7): `daisy token --for me` — the owner as a visitor,
    // a person of their own to the call authorization (cards, grants).
    if (p.selfToken) return { key: SELF_PERSON, contactId: null, issuer: null, subject: p.subject, name: selfName() };
    if (p.contactId) {
      const c = this.contacts.get(p.contactId);
      return c ? { key: c.id, contactId: c.id, issuer: null, subject: c.urn, name: shown(c.name, NAME_MAX) } : null;
    }
    if (!p.issuer || !p.subjectHash) return null;
    return {
      key: issuerPersonKey(p.issuer, p.subjectHash),
      contactId: null,
      issuer: p.issuer,
      subject: p.subject,
      name: shown(p.subject, NAME_MAX - externalMark().length) + externalMark(),
    };
  }
  /** Admission for a (stored or live) person: recognised now, and in the agent's range. */
  private admitWho(who: Who | null, agent: AgentInfo | null): Admission {
    if (!who) return { outcome: "refused", reason: "not_recognised" };
    // An issuer's person is someone only under the issuer that vouched for them.
    // P4-12: the owner as a visitor (`daisy token --for me`) is recognised.
    if (!who.contactId && who.key !== SELF_PERSON && (!who.issuer || who.issuer !== this.issuerNow()))
      return { outcome: "refused", reason: "not_recognised" };
    const p = {
      kind: "visitor",
      channel: "a2a",
      face: "external",
      label: "",
      scopes: ["daisy:invoke"],
      subject: who.subject,
      ...(who.contactId ? { contactId: who.contactId } : {}),
    } as Principal;
    const a = admit(p, agent ? this.openness(agent) : { openTo: "private" }, this.contacts);
    // Review L-6: a private agent and a missing one read the same.
    if (a.outcome === "refused" && a.reason === "agent_private") return { outcome: "refused", reason: "agent_unknown" as any };
    if (a.outcome === "refused" && !agent && a.reason !== "not_recognised") return { outcome: "refused", reason: "agent_unknown" as any };
    return a;
  }
  /** Can this person start a call on this agent right now without a card? */
  private standing(who: Who, agentId: string): { via: Exclude<CallVia, "once"> } | { refused: string } | null {
    const a = this.admitWho(who, this.agents.resolve(agentId));
    if (a.outcome === "refused") return { refused: a.reason };
    if (a.outcome === "allowed") return { via: a.via };
    return this.grantRow(agentId, who.key) ? { via: "grant" } : null;
  }

  // ── the range (5.2 开放范围) ─────────────────────────────────────────────
  /** What admission sees: private, open to all contacts, or listed people only. */
  openness(agent: AgentInfo): AgentOpenness {
    if (agent.kind === "private") return { openTo: "private" };
    const row = this.store.one("SELECT open_to FROM invoke_audiences WHERE agent_id=?", agent.id);
    if (!row || row.open_to === "all") return { openTo: "all" };
    return {
      openTo: "listed",
      listed: this.store
        .all("SELECT person FROM invoke_audience_members WHERE agent_id=? ORDER BY added_at, person", agent.id)
        .map((r) => r.person as string),
    };
  }

  audience(agentId: string): AgentAudience {
    const agent = this.agentOr404(agentId);
    const row = this.store.one("SELECT * FROM invoke_audiences WHERE agent_id=?", agentId);
    const listed = this.store
      .all("SELECT person FROM invoke_audience_members WHERE agent_id=? ORDER BY added_at, person", agentId)
      .map((r): InvokePerson => {
        const c = this.contacts.get(r.person);
        return c
          ? { key: c.id, contactId: c.id, issuer: null, subject: c.urn, name: shown(c.name, NAME_MAX) }
          : { key: r.person, contactId: null, issuer: null, subject: "", name: shown(r.person, NAME_MAX) };
      });
    return {
      agentId,
      kind: agent.kind,
      openTo: row?.open_to ?? "all",
      listed,
      set: !!row,
      updatedAt: row?.updated_at ?? null,
    };
  }

  /**
   * Change an agent's range (the owner, with the PIN — the route checks).
   * `listed`: what the owner typed for each contact (identity number or a
   * unique prefix); omitted keeps the list. Narrowing stops calls and
   * closes cards of those no longer in range.
   */
  setAudience(
    agentId: string,
    b: { openTo: "all" | "listed"; listed?: readonly string[] },
    by: string,
  ): AgentAudience & { stopped: number } {
    this.agentOr404(agentId);
    // Resolve every name first (a typo changes nothing).
    const people = b.listed?.map((ref) => this.contacts.find(ref).id);
    const at = this.now();
    const stopped = this.store.atomic(() => {
      this.store.run(
        "INSERT INTO invoke_audiences(agent_id,open_to,updated_at) VALUES(?,?,?) ON CONFLICT(agent_id) DO UPDATE SET open_to=excluded.open_to,updated_at=excluded.updated_at",
        agentId,
        b.openTo,
        at,
      );
      if (people) {
        this.store.run("DELETE FROM invoke_audience_members WHERE agent_id=?", agentId);
        for (const [i, p] of [...new Set(people)].entries())
          this.store.run("INSERT INTO invoke_audience_members(agent_id,person,added_at) VALUES(?,?,?)", agentId, p, at + i);
      }
      this.store.audit(by, "invoke.audience", JSON.stringify({ agent: agentId, openTo: b.openTo, listed: people?.length ?? null }), {
        object: `agent:${agentId}`,
      });
      return this.recheck({ agentId });
    });
    return { ...this.audience(agentId), stopped };
  }

  // ── the check ───────────────────────────────────────────────────────────
  /**
   * May `p` call `agentId` (5.4 step 2)? Refusals make no card; an
   * `ask_owner` raises one (or joins the pending one for this agent ×
   * person). Synchronous.
   */
  check(p: Principal | null | undefined, agentId: string): InvokeCheck {
    this.sweep();
    const agent = this.agents.resolve(agentId);
    const who = this.personOf(p);
    const a = this.admitWho(who, agent);
    if (a.outcome === "refused") {
      const reason = a.reason as InvokeRefusal;
      return { outcome: "refused", reason, message: REFUSED_TEXT(reason) };
    }
    const person: InvokePerson = { key: who!.key, contactId: who!.contactId, issuer: who!.issuer, subject: who!.subject, name: who!.name };
    if (a.outcome === "allowed") return { outcome: "allowed", via: a.via, person, agent: agent! };
    const actor = p?.actor ? shown(p.actor, LABEL_MAX) : null;
    return this.store.atomic((): InvokeCheck => {
      if (this.grantRow(agent!.id, person.key)) return { outcome: "allowed", via: "grant", person, agent: agent! };
      const now = this.now();
      const refusedAt = this.store.one(
        "SELECT MAX(decided_at) at FROM invoke_requests WHERE agent_id=? AND person=? AND decision='reject'",
        agent!.id,
        person.key,
      )?.at;
      if (refusedAt && now - refusedAt < CARD_LIMITS.callCooldownMs) return this.refused("rejected_recently");
      const open = this.store.one(
        "SELECT * FROM invoke_requests WHERE agent_id=? AND person=? AND status='pending'",
        agent!.id,
        person.key,
      );
      const ticket = randomUUID();
      if (open) {
        // Review M-3: a bounded number of calls wait on one card.
        if (this.waitingOn(open.id) >= CARD_LIMITS.callCardMaxWaiting) return this.refused("too_many_waiting");
        this.store.run("UPDATE invoke_requests SET calls=calls+1 WHERE id=?", open.id);
        this.addTicket(ticket, open.id, actor, false);
        // The owner's notice shows the new count (the outlet's 「出现」 is once per card).
        this.emit(this.row(open.id)!);
        return { outcome: "pending", requestId: PREFIX + open.id, ticket, raised: false, person, agent: agent! };
      }
      // Review L-2: no flood of cards (in all, and from one issuer's people).
      if (this.store.one("SELECT COUNT(*) n FROM invoke_requests WHERE status='pending'").n >= CARD_LIMITS.callCardsPendingMax)
        return this.refused("too_many_requests");
      if (
        person.issuer &&
        this.store.one("SELECT COUNT(*) n FROM invoke_requests WHERE status='pending' AND issuer=?", person.issuer).n >=
          CARD_LIMITS.callCardsPendingPerIssuer
      )
        return this.refused("too_many_requests");
      const rid = newId();
      this.store.run(
        "INSERT INTO invoke_requests(id,agent_id,agent_name,agent_session,person,contact_id,issuer,subject,actor,name,status,created,expires_at,calls) VALUES(?,?,?,?,?,?,?,?,?,?,'pending',?,?,1)",
        rid,
        agent!.id,
        shown(agent!.name, 200),
        agent!.sessionId,
        person.key,
        person.contactId,
        person.issuer,
        person.subject,
        actor,
        person.name,
        now,
        now + CARD_LIMITS.callCardTtlMs,
      );
      this.addTicket(ticket, rid, actor, true);
      this.store.audit("system", "invoke.request", JSON.stringify({ request: PREFIX + rid, agent: agent!.id, person: person.key }), {
        object: PREFIX + rid,
      });
      this.emit(this.row(rid)!);
      return { outcome: "pending", requestId: PREFIX + rid, ticket, raised: true, person, agent: agent! };
    });
  }

  /**
   * 5.11 「外面来的」: may `p` see this agent's card — recognised and in the
   * range (whether or not a call would need the owner). Never raises a card.
   */
  canSee(p: Principal | null | undefined, agentId: string): boolean {
    const agent = this.agents.resolve(agentId);
    if (!agent) return false;
    return this.admitWho(this.personOf(p), agent).outcome !== "refused";
  }

  /**
   * Wait until this call's card is decided (or expires, or is voided).
   * Resolves at once if it already was — re-asked now, not as it was
   * (review M-1: a revoked grant, a removed contact since the decision →
   * refused). `signal` gives up waiting (rejects with its reason; the
   * call leaves the card).
   */
  wait(d: { ticket: string }, signal?: AbortSignal): Promise<InvokeSettlement> {
    this.sweep();
    const t = this.ticketRow(d.ticket);
    if (!t) return Promise.reject(InvokeError.of(404, "request_not_found", "server-invoke.error.notWaiting"));
    const done = this.settlementOf(t);
    if (done) return Promise.resolve(done);
    return new Promise((resolve, reject) => {
      const fn = (s: InvokeSettlement) => {
        this.waiters.delete(d.ticket);
        signal?.removeEventListener("abort", abort);
        resolve(s);
      };
      const abort = () => {
        this.waiters.delete(d.ticket);
        this.leave(d.ticket);
        reject(signal!.reason ?? new Error("aborted"));
      };
      if (signal?.aborted) return abort();
      signal?.addEventListener("abort", abort, { once: true });
      this.waiters.set(d.ticket, fn);
    });
  }

  /**
   * A call starts executing (review M-1): checked again, atomically, now —
   * recognised, in range, and let in outright, by a grant, or by its own
   * 仅本次 card (`ticket`; that card starts one call only). Throws
   * InvokeError 403 `not_admitted` otherwise. `stop` ends the call when a
   * permission is taken back; `end()` the handle when it finishes.
   */
  begin(
    p: Principal | null | undefined,
    agentId: string,
    o: { ticket?: string; stop: (why: StopReason) => void },
  ): CallHandle {
    return this.store.atomic(() => {
      const who = this.personOf(p);
      const no = (why: MessageKey): never => {
        throw InvokeError.of(403, "not_admitted", "server-invoke.error.notAdmitted", { why: ownerT().dynamic(why) });
      };
      if (!who) return no(refusedKey("not_recognised"));
      const s = this.standing(who, agentId);
      let via: CallVia;
      if (s && "refused" in s) return no(refusedKey(s.refused));
      if (s) via = s.via;
      else {
        const t = o.ticket ? this.ticketRow(o.ticket) : null;
        const r = t && this.row(t.request_id);
        if (
          !t ||
          !r ||
          r.agent_id !== agentId ||
          r.person !== who.key ||
          r.status !== "approved" ||
          r.decision !== "once" ||
          !t.raiser ||
          r.used_at
        )
          return no("server-invoke.why.needsApproval");
        this.store.run("UPDATE invoke_requests SET used_at=? WHERE id=? AND used_at IS NULL", this.now(), r.id);
        via = "once";
      }
      if (o.ticket) this.store.run("DELETE FROM invoke_request_calls WHERE ticket=? AND request_id IN (SELECT id FROM invoke_requests WHERE status<>'pending')", o.ticket);
      return this.live.add({
        agentId,
        person: who.key,
        contactId: who.contactId,
        issuer: who.issuer,
        subject: who.subject,
        via,
        stop: o.stop,
      });
    });
  }

  // ── the owner's side ────────────────────────────────────────────────────
  requests(status: "pending" | "decided" | "all", limit = 100): InvokeRequest[] {
    this.sweep();
    const where = status === "pending" ? "WHERE status='pending'" : status === "decided" ? "WHERE status<>'pending'" : "";
    // Pending first: decided history never pushes an open card off the list.
    return this.store
      .all(`SELECT * FROM invoke_requests ${where} ORDER BY status='pending' DESC, created DESC, id DESC LIMIT ?`, limit)
      .map((r) => this.view(r));
  }
  request(requestId: string): InvokeRequest {
    this.sweep();
    const r = this.row(requestKey(requestId));
    if (!r) throw InvokeError.of(404, "request_not_found", "server-invoke.error.requestNotFound");
    return this.view(r);
  }

  /**
   * The owner decides (5.6: 永久通过 / 仅本次 / 拒绝 — the route asks for the
   * PIN). The same decision again answers the card as it stands.
   * 仅本次 lets through only the call that raised the card (review M-3);
   * the calls that joined it move to a new card, asked about afresh.
   */
  decide(requestId: string, decision: InvokeDecisionKey, by: string, note?: string): InvokeRequest {
    this.sweep();
    const rid = requestKey(requestId);
    let moved: string | null = null;
    const out = this.store.atomic(() => {
      const r = this.row(rid);
      if (!r) throw InvokeError.of(404, "request_not_found", "server-invoke.error.requestNotFound");
      if (r.status !== "pending") {
        if (r.decision === decision) return this.view(r);
        throw r.status === "expired"
          ? InvokeError.of(409, "request_closed", "server-invoke.error.requestExpired")
          : r.status === "canceled"
            ? InvokeError.of(409, "request_closed", "server-invoke.error.requestVoid", {
                why: sayWhy(r.closed_why ?? "server-invoke.why.changed"),
              })
            : InvokeError.of(409, "request_closed", "server-invoke.error.requestDecided", {
                label: decisionLabel(r.decision),
              });
      }
      // Still the same situation? (The person removed, the agent made
      // private or narrowed since the card was raised: nothing to approve.)
      if (decision !== "reject") {
        const a = this.admitWho(rowPerson(r), this.agents.resolve(r.agent_id));
        if (a.outcome === "refused") {
          const why = this.whyNot(a.reason);
          this.close(r, "canceled", why);
          throw InvokeError.of(409, "request_stale", "server-invoke.error.requestVoid", { why: sayWhy(why) });
        }
      }
      const at = this.now();
      this.store.run(
        "UPDATE invoke_requests SET status=?,decision=?,note=?,decided_by=?,decided_at=? WHERE id=?",
        decision === "reject" ? "rejected" : "approved",
        decision,
        note ?? null,
        by,
        at,
        rid,
      );
      if (decision === "always")
        this.store.run(
          "INSERT INTO invoke_grants(id,agent_id,person,contact_id,issuer,subject,name,granted_at,request_id) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(agent_id,person) DO NOTHING",
          newId(),
          r.agent_id,
          r.person,
          r.contact_id,
          r.issuer,
          r.subject,
          r.name,
          at,
          rid,
        );
      if (decision === "once") moved = this.moveJoined(r);
      this.store.audit(by, `invoke.request.${decision}`, JSON.stringify({ request: PREFIX + rid, agent: r.agent_id, person: r.person }), {
        object: PREFIX + rid,
      });
      const v = this.row(rid)!;
      this.emit(v);
      return this.view(v);
    });
    this.settle(rid);
    if (moved) this.settle(moved);
    return out;
  }

  grants(f: { agent?: string; contact?: string } = {}): InvokeGrant[] {
    const person = f.contact ? this.contacts.find(f.contact).id : undefined;
    return this.store
      .all(
        `SELECT * FROM invoke_grants WHERE (? IS NULL OR agent_id=?) AND (? IS NULL OR person=?) ORDER BY granted_at, id`,
        f.agent ?? null,
        f.agent ?? null,
        person ?? null,
        person ?? null,
      )
      .map((r) => grantView(r, this.agents.resolve(r.agent_id)?.name ?? r.agent_id));
  }

  /** Revoke one grant (the route asks for the PIN). Its person's calls that stood on it stop (T-5). */
  revokeGrant(gid: string, by: string): { revoked: InvokeGrant; stopped: number } {
    return this.store.atomic(() => {
      const r = this.store.one("SELECT * FROM invoke_grants WHERE id=?", gid);
      if (!r) throw InvokeError.of(404, "grant_not_found", "server-invoke.error.grantNotFound");
      this.store.run("DELETE FROM invoke_grants WHERE id=?", gid);
      this.store.audit(by, "invoke.grant.revoke", JSON.stringify({ grant: gid, agent: r.agent_id, person: r.person }), {
        object: `grant:${gid}`,
      });
      const stopped = this.recheck({ agentId: r.agent_id, person: r.person }, {
        code: "grant_revoked",
        message: ownerT()("server-invoke.stop.grantRevoked"),
      });
      return { revoked: grantView(r, this.agents.resolve(r.agent_id)?.name ?? r.agent_id), stopped };
    });
  }

  // ── stopping ────────────────────────────────────────────────────────────
  /**
   * Re-ask, for each call in progress (and each pending card) matching
   * `f`, whether it would still get in without asking. Stops the calls
   * that would not; closes the cards of people now refused outright — and
   * settles, as let in, the cards of people now let in outright (review
   * L-5). Returns how many calls were stopped.
   */
  recheck(f: CallFilter = {}, why?: StopReason): number {
    const stopped = this.live.stop(
      f,
      why ?? { code: "not_admitted", message: ownerT()("server-invoke.stop.notAdmitted") },
      (c) => !this.stillIn(c),
    );
    const cards = this.store.all(
      "SELECT * FROM invoke_requests WHERE status='pending' AND (? IS NULL OR agent_id=?) AND (? IS NULL OR person=?)",
      f.agentId ?? null,
      f.agentId ?? null,
      f.person ?? null,
      f.person ?? null,
    );
    for (const r of cards) {
      const s = this.standing(rowPerson(r), r.agent_id);
      if (!s) continue;
      this.close(r, "canceled", "refused" in s ? this.whyNot(s.refused) : "server-invoke.why.noLongerNeeded");
      this.settle(r.id);
    }
    return stopped;
  }

  /**
   * Review M-2: the external issuer was removed or replaced — the people
   * any other issuer vouched for are nobody now. Their grants go, their
   * cards are voided, their calls stop. Sync (inside the route's commit).
   */
  forgetIssuersBut(current: string | null): number {
    const gone = (x: { issuer: string | null }) => !!x.issuer && x.issuer !== current;
    const cards = this.store.atomic(() => {
      this.store.run("DELETE FROM invoke_grants WHERE issuer IS NOT NULL AND (? IS NULL OR issuer<>?)", current, current);
      const cs = this.store.all("SELECT * FROM invoke_requests WHERE status='pending' AND issuer IS NOT NULL AND (? IS NULL OR issuer<>?)", current, current);
      for (const r of cs) this.close(r, "canceled", "server-invoke.why.issuerGone");
      return cs;
    });
    for (const r of cards) this.settle(r.id);
    return this.live.stop({}, { code: "issuer_changed", message: ownerT()("server-invoke.stop.issuerChanged") }, gone);
  }

  /**
   * Review L-4: an agent is gone (a session deleted; P4-06 / P4-07 call it
   * too) — its grants, range and cards go, its calls stop.
   */
  forgetAgent(agentId: string): number {
    const cards = this.store.atomic(() => {
      this.store.run("DELETE FROM invoke_grants WHERE agent_id=?", agentId);
      this.store.run("DELETE FROM invoke_audience_members WHERE agent_id=?", agentId);
      this.store.run("DELETE FROM invoke_audiences WHERE agent_id=?", agentId);
      const cs = this.store.all("SELECT * FROM invoke_requests WHERE status='pending' AND agent_id=?", agentId);
      for (const r of cs) this.close(r, "canceled", "server-invoke.why.agentGone");
      return cs;
    });
    for (const r of cards) this.settle(r.id);
    const stopped = this.live.stop({ agentId }, { code: "agent_gone", message: ownerT()("server-invoke.stop.agentGone") });
    // P4-06 (ADR-125): whoever keeps something per agent forgets it too
    // (P4-05's 办 settings, the A2A server's open tasks, the public row).
    for (const fn of this.goneListeners) fn(agentId);
    return stopped;
  }
  private goneListeners: ((agentId: string) => void)[] = [];
  /**
   * P4-06: called (synchronously, after the grants, range and cards are
   * gone and the calls stopped) whenever an agent is forgotten — a session
   * deleted, a public agent taken back, a resident closed (P4-07).
   */
  onAgentGone(fn: (agentId: string) => void): void {
    this.goneListeners.push(fn);
  }

  /** PIN reset (T-9), in its transaction: every grant, named list, whitelist flag and pending card. */
  revokeAll(): number {
    return this.store.atomic(() => {
      const grants = Number(this.store.run("DELETE FROM invoke_grants").changes);
      const listed = Number(this.store.run("DELETE FROM invoke_audience_members").changes);
      const whitelist = Number(this.store.run("UPDATE contacts SET whitelisted=0 WHERE whitelisted=1").changes);
      const pending = this.store.all("SELECT * FROM invoke_requests WHERE status='pending'");
      for (const r of pending) this.close(r, "canceled", "server-invoke.why.pinReset");
      return grants + listed + whitelist + pending.length;
    });
  }
  /** PIN reset, after the database: every call in progress stops; waiters hear their cards closed. */
  stopAll(): number {
    for (const ticket of [...this.waiters.keys()]) this.settleTicket(ticket);
    return this.live.stop({}, { code: "reset", message: ownerT()("server-invoke.stop.reset") });
  }

  /** Cards past their 7 days (lazily, and on createApp's timer); old waiting places. */
  sweep(): number {
    const now = this.now();
    const due = this.store.all("SELECT * FROM invoke_requests WHERE status='pending' AND expires_at<=?", now);
    if (due.length)
      this.store.atomic(() => {
        for (const r of due) {
          this.close(r, "expired", "server-invoke.why.expired");
          this.store.audit("system", "invoke.request.expired", JSON.stringify({ request: PREFIX + r.id }), { object: PREFIX + r.id });
        }
      });
    for (const r of due) this.settle(r.id);
    this.store.run(
      "DELETE FROM invoke_request_calls WHERE created<? AND request_id NOT IN (SELECT id FROM invoke_requests WHERE status='pending')",
      now - CARD_LIMITS.callCardTtlMs - 24 * 3600_000,
    );
    return due.length;
  }

  // ── inside ──────────────────────────────────────────────────────────────
  private refused(reason: InvokeRefusal): InvokeCheck {
    return { outcome: "refused", reason, message: REFUSED_TEXT(reason) };
  }
  /** Why a card closes (a message key: `closed_why` stores keys, said when read). */
  private whyNot(reason: string): MessageKey {
    return reason === "not_recognised"
      ? "server-invoke.why.notRecognised"
      : reason === "agent_unknown"
        ? "server-invoke.why.agentClosed"
        : "server-invoke.why.notOpenToThem";
  }
  private row(rid: string): any {
    return this.store.one("SELECT * FROM invoke_requests WHERE id=?", rid);
  }
  private ticketRow(ticket: string): any {
    return this.store.one("SELECT * FROM invoke_request_calls WHERE ticket=?", ticket);
  }
  private waitingOn(rid: string): number {
    return this.store.one("SELECT COUNT(*) n FROM invoke_request_calls WHERE request_id=?", rid).n;
  }
  private addTicket(ticket: string, rid: string, actor: string | null, raiser: boolean) {
    this.store.run(
      "INSERT INTO invoke_request_calls(ticket,request_id,actor,created,raiser) VALUES(?,?,?,?,?)",
      ticket,
      rid,
      actor,
      this.now(),
      raiser ? 1 : 0,
    );
  }
  private grantRow(agentId: string, person: string): any {
    return this.store.one("SELECT * FROM invoke_grants WHERE agent_id=? AND person=?", agentId, person);
  }
  private agentOr404(agentId: string): AgentInfo {
    const a = this.agents.resolve(agentId);
    if (!a) throw InvokeError.of(404, "agent_not_found", "server-invoke.error.agentNotFound");
    return a;
  }
  /** Would this call still get in without a card? (A 仅本次 call: unless refused outright.) */
  private stillIn(c: ActiveCall): boolean {
    const s = this.standing({ key: c.person, contactId: c.contactId, issuer: c.issuer, subject: c.subject }, c.agentId);
    if (s && "refused" in s) return false;
    return !!s || c.via === "once";
  }
  /**
   * 仅本次: the calls that joined the card (all but the one that raised it)
   * move to a new card. Returns its id (null: none joined).
   */
  private moveJoined(r: any): string | null {
    const joined = this.store.all("SELECT ticket FROM invoke_request_calls WHERE request_id=? AND raiser=0 ORDER BY created, ticket", r.id);
    if (!joined.length) return null;
    const rid = newId();
    const now = this.now();
    this.store.run(
      "INSERT INTO invoke_requests(id,agent_id,agent_name,agent_session,person,contact_id,issuer,subject,actor,name,status,created,expires_at,calls) VALUES(?,?,?,?,?,?,?,?,?,?,'pending',?,?,?)",
      rid,
      r.agent_id,
      r.agent_name,
      r.agent_session,
      r.person,
      r.contact_id,
      r.issuer,
      r.subject,
      r.actor,
      r.name,
      now,
      now + CARD_LIMITS.callCardTtlMs,
      joined.length,
    );
    this.store.run("UPDATE invoke_request_calls SET request_id=? WHERE request_id=? AND raiser=0", rid, r.id);
    this.store.run("UPDATE invoke_request_calls SET raiser=1 WHERE ticket=?", joined[0].ticket);
    this.store.audit("system", "invoke.request", JSON.stringify({ request: PREFIX + rid, agent: r.agent_id, person: r.person, from: PREFIX + r.id }), {
      object: PREFIX + rid,
    });
    this.emit(this.row(rid)!);
    return rid;
  }
  /** A call gave up waiting: it leaves its card (the next one in line may be let through by 仅本次). */
  /**
   * P4-04 review L-4 (a2a-usage.md §5 取消): the caller canceled a call that
   * was waiting on a card — it leaves the card, and a card nobody waits on
   * any more is closed (canceled, its notice and event resolved). Unlike an
   * abandoned `wait` (a restart, a dropped connection: the card stays for
   * the owner). Idempotent; a ticket that is not waiting does nothing.
   */
  withdraw(ticket: string): void {
    this.store.atomic(() => {
      const t = this.ticketRow(ticket);
      if (!t) return;
      this.leave(ticket);
      const r = this.row(t.request_id);
      if (r?.status !== "pending") return;
      if (this.store.one("SELECT 1 FROM invoke_request_calls WHERE request_id=? LIMIT 1", r.id)) return;
      this.close(r, "canceled", "server-invoke.why.callerCanceled");
    });
  }
  private leave(ticket: string) {
    this.store.atomic(() => {
      const t = this.ticketRow(ticket);
      if (!t) return;
      const r = this.row(t.request_id);
      if (r?.status !== "pending") return;
      this.store.run("DELETE FROM invoke_request_calls WHERE ticket=?", ticket);
      if (t.raiser)
        this.store.run(
          "UPDATE invoke_request_calls SET raiser=1 WHERE ticket=(SELECT ticket FROM invoke_request_calls WHERE request_id=? ORDER BY created, ticket LIMIT 1)",
          t.request_id,
        );
    });
  }
  private close(r: any, status: "expired" | "canceled", why: MessageKey) {
    this.store.run("UPDATE invoke_requests SET status=?,closed_why=? WHERE id=? AND status='pending'", status, why, r.id);
    this.emit(this.row(r.id)!);
  }
  private view(r: any): InvokeRequest {
    const tickets = this.store.all("SELECT actor FROM invoke_request_calls WHERE request_id=? ORDER BY created, ticket", r.id);
    const actors = [...new Set([r.actor, ...tickets.map((t) => t.actor)].filter((x): x is string => !!x))].map((x) => shown(x, LABEL_MAX));
    return {
      id: PREFIX + r.id,
      status: r.status,
      agent: { id: r.agent_id, name: r.agent_name, sessionId: r.agent_session ?? null },
      caller: { ...rowPerson(r), actor: r.actor ?? null },
      created: r.created,
      expiresAt: r.expires_at,
      calls: r.calls,
      waiting: r.status === "pending" ? tickets.length : 0,
      actors,
      options: INVOKE_DECISIONS.map((key) => ({ key, label: decisionLabel(key) })),
      decision: r.decision
        ? {
            choice: r.decision,
            label: decisionLabel(r.decision),
            note: r.note ?? null,
            by: r.decided_by ?? "",
            at: r.decided_at ?? 0,
          }
        : null,
      closedWhy: r.closed_why ? sayWhy(r.closed_why) : null,
    };
  }
  private emit(r: any) {
    const v = this.view(r);
    const title = cardTitle(v);
    for (const f of this.listeners) f(v.status, v, title);
  }
  /**
   * How a waiting call's card ended — re-asked now (review M-1): an
   * approval stands only while the person is still let in, and 仅本次 only
   * for the call that raised the card, before it began.
   */
  private settlementOf(t: any): InvokeSettlement | null {
    const r = this.row(t.request_id);
    if (!r) return { outcome: "refused", reason: "canceled", message: SETTLED_WHY("canceled") };
    if (r.status === "pending") return null;
    if (r.status === "rejected" || r.status === "expired")
      return { outcome: "refused", reason: r.status, message: SETTLED_WHY(r.status as "rejected" | "expired") };
    const s = this.standing(rowPerson(r), r.agent_id);
    const canceled = (why: string): InvokeSettlement => ({
      outcome: "refused",
      reason: "canceled",
      message: ownerT()("server-invoke.settled.canceledWhy", { why: sayWhy(why) }),
    });
    if (s && "refused" in s) return canceled(this.whyNot(s.refused));
    if (s) return { outcome: "allowed", via: s.via };
    if (r.status === "approved" && r.decision === "once" && t.raiser && !r.used_at) return { outcome: "allowed", via: "once" };
    if (r.status === "approved") return canceled(r.decision === "always" ? "server-invoke.why.grantRevoked" : "server-invoke.why.onceUsed");
    return canceled(r.closed_why ?? "server-invoke.why.changed");
  }
  private settleTicket(ticket: string) {
    const fn = this.waiters.get(ticket);
    if (!fn) return;
    const t = this.ticketRow(ticket);
    const s = t ? this.settlementOf(t) : ({ outcome: "refused", reason: "canceled", message: SETTLED_WHY("canceled") } as const);
    if (s) fn(s);
  }
  /** Tell the calls waiting on a card how it ended. */
  private settle(rid: string) {
    for (const t of this.store.all("SELECT ticket FROM invoke_request_calls WHERE request_id=?", rid)) this.settleTicket(t.ticket);
  }
  /** A removed contact (P4-01 `onRemoved`, in its transaction). */
  private forget(contactId: string) {
    this.store.run("DELETE FROM invoke_grants WHERE person=?", contactId);
    this.store.run("DELETE FROM invoke_audience_members WHERE person=?", contactId);
    const cards = this.store.all("SELECT * FROM invoke_requests WHERE status='pending' AND person=?", contactId);
    for (const r of cards) this.close(r, "canceled", "server-invoke.why.contactRemoved");
    for (const r of cards) this.settle(r.id);
    this.live.stop({ person: contactId }, { code: "contact_removed", message: ownerT()("server-invoke.stop.contactRemoved") });
  }
}

/** The card's one line: who, which agent, and how many calls from how many AIs (review M-3). */
export function cardTitle(v: InvokeRequest): string {
  const t = ownerT();
  const p = { caller: v.caller.name, agent: v.agent.name, n: v.waiting, ais: v.actors.length };
  if (v.waiting <= 1) return t("server-invoke.card.title", { caller: p.caller, agent: p.agent });
  return v.actors.length > 1
    ? t("server-invoke.card.titleWaitingFrom", p)
    : t("server-invoke.card.titleWaiting", { caller: p.caller, agent: p.agent, n: p.n });
}

/**
 * A call card as the 「审批」 list's `kind: "call"` item takes it
 * (approvals.ts `callView`, contracts `DaisyCallApproval`): the fields
 * the old list had (`callerUser`, `callerSession`, the session asked),
 * plus `caller`, `agent`, `calls`, `waiting`, `actors` and `respondVia` —
 * the decision goes through the PIN route, not `/api/approvals/:id/respond`
 * (additive for a host's approvals page).
 */
export function callCardOf(r: InvokeRequest, ownerName: string) {
  return {
    id: r.id,
    status: r.status,
    created: r.created,
    expiresAt: r.expiresAt,
    offers: r.options.map((o) => o.key),
    calleeSession: { id: r.agent.sessionId ?? r.agent.id, title: r.agent.name, ownerName },
    callerUser: { id: r.caller.key, username: r.caller.name },
    callerSession: null,
    title: cardTitle(r),
    caller: r.caller,
    agent: r.agent,
    calls: r.calls,
    waiting: r.waiting,
    actors: r.actors,
    respondVia: { method: "POST" as const, path: `/api/requests/${encodeURIComponent(r.id)}/decision`, pin: true as const },
    ...(r.decision
      ? {
          decision: {
            choice: r.decision.choice,
            ...(r.decision.note ? { note: r.decision.note } : {}),
            by: { id: r.decision.by, username: r.decision.by },
            at: r.decision.at,
          },
        }
      : {}),
  };
}
