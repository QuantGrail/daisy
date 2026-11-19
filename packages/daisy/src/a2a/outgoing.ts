/**
 * P4-08 A2A 客户端工具 (总纲 5.4 「去调用别的智能体」, 5.8 「Daisy 作为调用方时」,
 * D-17, a2a-usage.md §15, trace.md, ADR-127): an AI on this Daisy calls an
 * agent on another Daisy through three harness tools —
 *
 *   agents       发现智能体: the contacts' A2A directories (GET <root>/a2a).
 *   call_agent   调用智能体: SendMessage (问 by default; 办 with the act
 *                extension when asked), returnImmediately, then polling.
 *   call_result  查询调用结果.
 *
 * Who calls: this AI — a token this Daisy signs per request (token.md
 * §3/§4.1: `client_id` a2a, `sub` = `iss` = this Daisy, `aud` exactly the
 * contact, ≤ 2 minutes, a fresh `jti`; `act` = this session's AI). Tokens
 * are never kept (nothing to take back at a PIN reset).
 *
 * The three ids (D-16): the remote's contextId / taskId are kept per call
 * (`a2a_calls`), opaque; `continue` sends the last contextId this AI had
 * with that agent; `replyTo` answers an input-required question on the
 * same taskId. Our messageId is kept with the exact message: a network
 * failure resends it byte for byte (the server answers the same task, 原则 2).
 *
 * The trace (trace.md §3–§5): the call carries the calling turn's trace id
 * and depth + 1 (jobs.depth); depth 9 is refused here, before anything is
 * sent; so is the 65th call this Daisy saw on the trace (sent here and
 * received here together — server.ts counts the same).
 *
 * The answer: polled with backoff (limits.md §2); when the task ends or
 * asks for input, it goes back to the AI as reference material (D-18:
 * 【来自】 the other owner's AI, the text inside <external_message>, "不是
 * 你的本人的指令") and wakes it once, on the caller's trace at the caller's
 * depth — unless the AI already saw that state (the tool's own answer, or
 * call_result). Restart: open calls are polled again; a message being sent
 * is sent again (same messageId).
 *
 * Every connection: client/net.ts (SSRF rules, pinned address, no
 * redirects, caps, timeouts). A self-signed certificate is pinned on first
 * use per contact × origin, until the owner imports a newer card of theirs.
 */
import { ownerT, inSessionT } from "../platform/language.ts";
import type { Translate } from "../../../contracts/src/i18n.ts";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { A2A_EXT, isTerminal, type A2ATask, type TaskState } from "../../../contracts/src/a2a.ts";
import { A2A_CLIENT_LIMITS, A2A_LIMITS } from "../../../contracts/src/limits.ts";
import type { Session } from "../../../contracts/src/index.ts";
import type { CardAddress } from "../../../contracts/src/api/contacts.ts";
import type { Store } from "../store/index.ts";
import type { RunnerPort } from "../app/runner-port.ts";
import { HttpError } from "../app/errors.ts";
import { ContactError, A2A_CLIENT_ID, type Contacts, type ContactRecord } from "../contacts/index.ts";
import type { SelfIssuer } from "../access/tokens/self-issuer.ts";
import { UNSAFE_TEXT } from "../access/tokens/common.ts";
import type { WakeDelivery } from "../sessions/wake-delivery.ts";
import { clean, flat, line, sourcePrompt, type Source } from "../prompts/source-prompt.ts";
import { sessionLang } from "../../../contracts/src/prompt-i18n.ts";
import { formatTraceparent, isTraceId, newSpanId, newTraceId } from "../observe/trace.ts";
import { log } from "../observe/log.ts";
import { traceCalls } from "./server.ts";
import { A2APeer, PeerError, answerOf, partsText, reasonOf, type PeerCard, type TlsSeen, type OutboundPolicy } from "./client/index.ts";
import { bindingVerifierFor, type TlsBindingVerifier } from "../../../a2a-client/src/index.ts";

type Limits = { -readonly [K in keyof typeof A2A_CLIENT_LIMITS]: number };

/** Not a TASK_STATE_*: the message is on its way (or being resent). */
const SENDING = "sending";
/** Not a TASK_STATE_*: ended here, without the other side's task (refused, offline, gone). */
const ERROR = "error";
const settledState = (s: string) => s === ERROR || s === "TASK_STATE_INPUT_REQUIRED" || isTerminal(s);

/** P4-12: also the owner's 「我的 AI 调用了谁」 (outgoing-routes.ts). P6-23b: in `t`'s language. */
export function stateLabel(state: string, t: Translate = ownerT()): string {
  const key = `server-a2a.call.state.${state}`;
  return t.has(key) ? t.dynamic(key) : state;
}

/**
 * P6-23b: what the AI reads (tool answers, wakes) and what is stored for
 * its session (a call's status text): that session's language.
 */
const tOf = (s: Session | null | undefined): Translate => inSessionT(s);
const say = (t: Translate, key: string, params?: Record<string, unknown>) => t.dynamic(`server-a2a.call.${key}`, params);

const CallArgs = z.object({
  contact: z.string().trim().min(1).max(200).optional(),
  agent: z.string().trim().min(1).max(A2A_LIMITS.idMax).optional(),
  text: z.string().min(1).max(A2A_CLIENT_LIMITS.textMax),
  mode: z.enum(["ask", "act"]).default("ask"),
  continue: z.boolean().default(false),
  replyTo: z.string().trim().min(1).max(100).optional(),
});
const AgentsArgs = z.object({ contact: z.string().trim().min(1).max(200).optional() });
const ResultArgs = z.object({ callId: z.string().trim().min(1).max(100).optional() });

const sleep = (ms: number) =>
  new Promise<void>((r) => (setTimeout(r, ms) as unknown as { unref?: () => void }).unref?.());

/** Remote-provided content, for the AI: data inside the tags, never instructions. */
function external(fields: Record<string, unknown>): string {
  return `<external_message>\n${clean(JSON.stringify(fields))}\n</external_message>`;
}

/** The AI's display name for `act.name` (the other side refuses control / direction characters). */
function actName(s: Session): string | undefined {
  const n = String(s.title ?? "")
    .replace(new RegExp(UNSAFE_TEXT.source, "g"), "")
    .trim()
    .slice(0, 64);
  return n || undefined;
}

function zodMessage(e: z.ZodError, t: Translate): string {
  return e.issues
    .slice(0, 3)
    .map((i) => say(t, "zod.issue", { path: i.path.join(".") || say(t, "zod.param"), message: i.message }))
    .join(say(t, "zod.separator"));
}

export interface OutgoingDeps {
  store: Store;
  contacts: Contacts;
  /** This Daisy's signing identity (access.ai.self). */
  self: SelfIssuer;
  wakes: WakeDelivery;
  ownerName: () => string;
  /** Tests only (createApp `a2aClient`): loopback allowed, a stand-in resolver. */
  policy?: OutboundPolicy;
  /** Tests: shorter polling. */
  limits?: Partial<Limits>;
  now?: () => number;
}

export class A2AOutgoing {
  private L: Limits;
  private now: () => number;
  private inflight = new Map<string, Promise<void>>();
  /** Calls whose tool answer is still being composed: it reports the state, no wake. */
  private inline = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(private d: OutgoingDeps) {
    this.L = { ...A2A_CLIENT_LIMITS, ...d.limits } as Limits;
    this.now = d.now ?? Date.now;
    // A removed contact's pinned certificates go with them (in the removal's transaction).
    d.contacts.onRemoved((c) => {
      void d.store.run("DELETE FROM a2a_tls_pins WHERE contact_id=?", c.id);
      this.bindings.delete(c.id);
    });
  }

  /** P5-02: each contact's TLS binding claims, learnt per origin (binding.ts). */
  private bindings = new Map<string, { x: string; v: TlsBindingVerifier }>();

  /** The binding verifier of a contact, for its key from the address book. */
  private bindingOf(contact: ContactRecord): TlsBindingVerifier {
    const b = this.bindings.get(contact.id);
    if (b && b.x === contact.key.x) return b.v;
    const v = bindingVerifierFor(contact.key, "relay", this.d.policy);
    if (this.bindings.size > 1024) this.bindings.clear();
    this.bindings.set(contact.id, { x: contact.key.x, v });
    return v;
  }

  /** Resume after a start: open calls are polled, a message being sent is sent again. */
  start() {
    this.d.store.run(
      "UPDATE a2a_calls SET next_at=? WHERE next_at IS NULL AND state NOT IN ('error','TASK_STATE_INPUT_REQUIRED','TASK_STATE_COMPLETED','TASK_STATE_FAILED','TASK_STATE_CANCELED','TASK_STATE_REJECTED')",
      this.now(),
    );
    this.arm();
  }

  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** The harness tools' calls (tools/daisy-tools.ts → the in-process Runner port). */
  register(runner: RunnerPort, sessionOf: (req: any) => Session) {
    runner.post("/sessions/:sid/a2a/agents", async (req: any) => this.agents(sessionOf(req), req.body ?? {}));
    runner.post("/sessions/:sid/a2a/call", async (req: any) => this.call(sessionOf(req), req.body ?? {}));
    runner.post("/sessions/:sid/a2a/result", async (req: any) => this.result(sessionOf(req), req.body ?? {}));
  }

  // ── helpers ─────────────────────────────────────────────────────────────
  private row(id: string): any {
    return this.d.store.one("SELECT * FROM a2a_calls WHERE id=?", id);
  }

  /** The turn a tool call belongs to: the one it names (in this session), else the running one. */
  private turnOf(sid: string, jobId: unknown): { id: string; trace: string | null; depth: number } | null {
    const named =
      typeof jobId === "string" && jobId.length <= 200
        ? this.d.store.one("SELECT id,session_id,trace,depth FROM jobs WHERE id=?", jobId)
        : null;
    if (named && named.session_id === sid) return named;
    return (
      this.d.store.one(
        "SELECT id,session_id,trace,depth FROM jobs WHERE session_id=? AND status='running' ORDER BY created DESC LIMIT 1",
        sid,
      ) ?? null
    );
  }

  /** A contact the AI named: identity number (or a unique prefix), else a unique exact name. */
  private contact(ref: string, t: Translate): ContactRecord {
    try {
      return this.d.contacts.find(ref);
    } catch (e) {
      if (!(e instanceof ContactError)) throw e;
      const byName = this.d.contacts.list().filter((c) => c.name.toLowerCase() === ref.trim().toLowerCase());
      if (byName.length === 1) return byName[0]!;
      throw new HttpError(
        404,
        say(t, e.code === "contact_ambiguous" || byName.length > 1 ? "contactAmbiguous" : "contactNotFound"),
        "contact_not_found",
      );
    }
  }

  /** A fresh cross-Daisy token for one request, as this AI (token.md §3). */
  private async token(contact: ContactRecord, s: Session): Promise<string> {
    const name = actName(s);
    const { token } = await this.d.self.sign({
      sub: this.d.self.urn,
      aud: contact.urn,
      clientId: A2A_CLIENT_ID,
      scope: "daisy:invoke",
      ttlS: Math.min(this.L.tokenTtlS, 300),
      act: { sub: `agent:${s.id}`, ...(name ? { name } : {}) },
    });
    return token;
  }

  /** A self-signed certificate: pinned on first use per contact × origin (ADR-127 §4). */
  private tlsCheck(contactId: string, seen: TlsSeen, t: Translate): true | string {
    const c = this.d.contacts.get(contactId);
    if (!c) return say(t, "contactGone");
    const pin = this.d.store.one("SELECT * FROM a2a_tls_pins WHERE contact_id=? AND origin=?", c.id, seen.origin);
    if (pin && pin.card_iat === c.cardIssuedAt) {
      if (pin.sha256 === seen.fingerprint) return true;
      this.d.store.audit("system", "a2a.tls.mismatch", JSON.stringify({ contact: c.id, origin: seen.origin }), {
        outcome: "denied",
        reason: "tls_changed",
      });
      return say(t, "tlsChanged");
    }
    this.d.store.run(
      "INSERT OR REPLACE INTO a2a_tls_pins(contact_id,origin,sha256,card_iat,first_seen) VALUES(?,?,?,?,?)",
      c.id,
      seen.origin,
      seen.fingerprint,
      c.cardIssuedAt,
      this.now(),
    );
    this.d.store.audit("system", "a2a.tls.pin", JSON.stringify({ contact: c.id, origin: seen.origin, sha256: seen.fingerprint }));
    return true;
  }

  private peer(contact: ContactRecord, addr: CardAddress, s: Session): A2APeer {
    return new A2APeer({
      root: addr.url,
      kind: addr.kind,
      token: () => this.token(contact, s),
      ...(this.d.policy ? { policy: this.d.policy } : {}),
      tlsCheck: (seen) => this.tlsCheck(contact.id, seen, tOf(s)),
      // P5-02 (ADR-100): a relay address — no token before the claim checks out.
      binding: {
        verifier: this.bindingOf(contact),
        onRefused: (origin, e) => {
          this.d.store.audit("system", "a2a.tls.binding_refused", JSON.stringify({ contact: contact.id, origin, why: e.code }), {
            outcome: "denied",
            reason: e.code === "mismatch" ? "tls_binding_mismatch" : "tls_binding_invalid",
          });
          log.error(`[a2a] call through the relay to ${contact.id.slice(0, 16)}… refused (TLS binding claim ${e.code}): ${e.message}`);
        },
      },
    });
  }

  private sessionOf(sid: string): Session | null {
    return this.d.store.session(sid) ?? null;
  }

  // ── agents (发现智能体) ────────────────────────────────────────────────
  async agents(s: Session, body: unknown): Promise<{ ok: true; text: string }> {
    const t = tOf(s);
    const a = AgentsArgs.safeParse(body ?? {});
    if (!a.success) throw new HttpError(400, zodMessage(a.error, t), "invalid_input");
    const all = a.data.contact ? [this.contact(a.data.contact, t)] : this.d.contacts.list();
    if (!all.length) return { ok: true, text: say(t, "emptyBook") };
    const list = all.slice(0, this.L.discoverContactsMax);
    const one = async (c: ContactRecord) => {
      if (!c.addrs.length) return { c, note: say(t, "noAddress") };
      let last: unknown = null;
      for (const addr of c.addrs) {
        try {
          return { c, agents: await this.peer(c, addr, s).directory() };
        } catch (e) {
          last = e;
          if (!(e instanceof PeerError) || e.kind !== "unreachable") break;
        }
      }
      return { c, note: this.failureText(last, t) };
    };
    const pending = list.map((c) => one(c).catch((e) => ({ c, note: this.failureText(e, t) })));
    const timeout = sleep(this.L.discoverTimeoutMs + 1500).then(() => null);
    const results = await Promise.all(pending.map((p, i) => Promise.race([p, timeout]).then((r) => r ?? { c: list[i]!, note: say(t, "noTimelyAnswer") })));
    const out: string[] = [say(t, "agents.intro"), say(t, "agents.how")];
    for (const r of results) {
      out.push(`\n${say(t, "agents.contact", { name: line(r.c.name, 60), id: r.c.id })}`);
      if ("agents" in r && r.agents) {
        if (!r.agents.length) out.push(say(t, "agents.none"));
        else out.push(external({ agents: r.agents.map((x) => ({ agentId: x.agentId, name: x.name })) }));
      } else out.push(`  ${(r as any).note}`);
    }
    if (all.length > list.length) out.push(`\n${say(t, "agents.more", { n: list.length })}`);
    return { ok: true, text: out.join("\n") };
  }

  // ── call_agent (调用智能体) ─────────────────────────────────────────────
  async call(s: Session, body: any): Promise<{ ok: boolean; text: string; call: { id: string; state: string } }> {
    const t = tOf(s);
    const turn = this.turnOf(s.id, body?.jobId);
    if (!turn) throw new HttpError(409, say(t, "noTurn"), "no_turn");
    const { jobId: _j, ...rest } = body ?? {};
    const parsed = CallArgs.safeParse(rest);
    if (!parsed.success) throw new HttpError(400, zodMessage(parsed.error, t), "invalid_input");
    const a = parsed.data;
    const store = this.d.store;
    const now = this.now();
    let id: string;
    let note = "";
    if (a.replyTo) {
      const row = store.one("SELECT * FROM a2a_calls WHERE id=? AND session_id=?", a.replyTo, s.id);
      if (!row) throw new HttpError(404, say(t, "replyNotFound"), "call_not_found");
      if (row.state !== "TASK_STATE_INPUT_REQUIRED" || this.inflight.has(row.id))
        throw new HttpError(
          409,
          say(t, "notInputRequired", { state: stateLabel(row.state, t) }),
          "not_input_required",
        );
      // trace.md §3: the caller's answer keeps the task's trace and depth.
      const m = this.message({
        text: a.text,
        mode: a.mode,
        traceId: row.trace_id,
        depth: row.depth,
        contextId: row.context_id,
        taskId: row.task_id,
      });
      store.run(
        "UPDATE a2a_calls SET message_id=?,message=?,extensions=?,mode=?,state=?,reason=NULL,status_text=NULL,answer=NULL,files=NULL,told=NULL,failures=0,delay=0,next_at=NULL,updated=?,job_id=? WHERE id=?",
        m.params.message.messageId,
        JSON.stringify(m.params),
        JSON.stringify(m.extensions),
        a.mode,
        SENDING,
        now,
        turn.id,
        row.id,
      );
      id = row.id;
    } else {
      if (!a.contact || !a.agent)
        throw new HttpError(400, say(t, "needTarget"), "invalid_input");
      const contact = this.contact(a.contact, t);
      if (!contact.addrs.length)
        throw new HttpError(409, say(t, "contactNoAddress"), "no_address");
      // trace.md §3 / §5: this turn's trace, one level deeper; refused here before anything is sent.
      const traceId = isTraceId(turn.trace) ? turn.trace : newTraceId();
      const depth = (Number(turn.depth) || 0) + 1;
      if (depth > A2A_LIMITS.traceMaxDepth)
        throw new HttpError(
          429,
          say(t, "chainDepth", { max: A2A_LIMITS.traceMaxDepth, depth: depth - 1 }),
          "chain_depth",
        );
      id = randomUUID();
      store.atomic(() => {
        // Sent here and received here, together (server.ts counts the same).
        if (traceCalls(store, traceId) + 1 > A2A_LIMITS.traceMaxCalls)
          throw new HttpError(
            429,
            say(t, "chainCalls", { max: A2A_LIMITS.traceMaxCalls }),
            "chain_calls",
          );
        const open = Number(
          store.one(
            `SELECT COUNT(*) n FROM a2a_calls WHERE session_id=? AND state NOT IN ('error','TASK_STATE_COMPLETED','TASK_STATE_FAILED','TASK_STATE_CANCELED','TASK_STATE_REJECTED')`,
            s.id,
          ).n,
        );
        if (open >= this.L.openPerSession)
          throw new HttpError(429, say(t, "tooMany", { n: open }), "too_many_calls");
        let contextId: string | null = null;
        if (a.continue) {
          contextId =
            store.one(
              "SELECT context_id FROM a2a_calls WHERE session_id=? AND contact_id=? AND agent_id=? AND context_id IS NOT NULL ORDER BY created DESC LIMIT 1",
              s.id,
              contact.id,
              a.agent,
            )?.context_id ?? null;
          if (!contextId) note = say(t, "newContext");
        }
        const m = this.message({ text: a.text, mode: a.mode, traceId, depth, contextId, taskId: null });
        store.run(
          "INSERT INTO a2a_calls(id,session_id,job_id,contact_id,contact_name,agent_id,agent_name,mode,message_id,message,extensions,context_id,state,trace_id,depth,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          id,
          s.id,
          turn.id,
          contact.id,
          contact.name,
          a.agent,
          a.agent,
          a.mode,
          m.params.message.messageId,
          JSON.stringify(m.params),
          JSON.stringify(m.extensions),
          contextId,
          SENDING,
          traceId,
          depth,
          now,
          now,
        );
        store.audit(`ai:${s.id}`, "a2a.call", JSON.stringify({ call: id, contact: contact.id, agent: a.agent, mode: a.mode }), {
          actor: "ai",
          object: `a2a-call:${id}`,
          traceId,
          depth,
          sessionId: s.id,
          jobId: turn.id,
        });
      });
    }
    // Wait a little for the first answer; the rest happens in the background.
    this.inline.add(id);
    try {
      await Promise.race([this.deliver(id), sleep(this.L.inlineWaitMs)]);
    } finally {
      this.inline.delete(id);
    }
    const row = this.row(id);
    if (settledState(row.state)) store.run("UPDATE a2a_calls SET told=? WHERE id=?", row.state, id);
    return {
      ok: row.state !== ERROR && row.state !== "TASK_STATE_REJECTED" && row.state !== "TASK_STATE_FAILED",
      text: this.describe(row, t) + note,
      call: { id, state: row.state },
    };
  }

  /** The SendMessage params and the extensions to enable (a2a-usage.md §8, trace.md §4). */
  private message(o: {
    text: string;
    mode: "ask" | "act";
    traceId: string;
    depth: number;
    contextId: string | null;
    taskId: string | null;
  }) {
    const extensions: string[] = [A2A_EXT.trace, ...(o.mode === "act" ? [A2A_EXT.act] : [])];
    const params = {
      message: {
        messageId: randomUUID(),
        role: "ROLE_USER",
        parts: [{ text: o.text }],
        ...(o.contextId ? { contextId: o.contextId } : {}),
        ...(o.taskId ? { taskId: o.taskId } : {}),
        extensions,
        metadata: {
          [A2A_EXT.trace]: { traceparent: formatTraceparent(o.traceId, newSpanId()), depth: o.depth },
          ...(o.mode === "act" ? { [A2A_EXT.act]: { mode: "act" } } : {}),
        },
      },
      configuration: { returnImmediately: true, acceptedOutputModes: ["text/plain"] },
    };
    return { params, extensions };
  }

  // ── sending and polling ─────────────────────────────────────────────────
  /** Send (or resend) a call's message — one at a time per call. */
  deliver(id: string): Promise<void> {
    let p = this.inflight.get(id);
    if (!p) {
      p = this.sendNow(id)
        .catch((e) => log.warn("a2a client: sending failed", { call: id, error: String((e as Error)?.message ?? e).slice(0, 200) }))
        .finally(() => {
          this.inflight.delete(id);
          this.arm();
        });
      this.inflight.set(id, p);
    }
    return p;
  }

  private addrsOf(contact: ContactRecord, prefer: string | null): CardAddress[] {
    const a = contact.addrs.slice();
    a.sort((x, y) => Number(y.url === prefer) - Number(x.url === prefer));
    return a;
  }

  private async sendNow(id: string) {
    const row = this.row(id);
    if (!row || row.state !== SENDING || this.closed) return;
    const s = this.sessionOf(row.session_id);
    const contact = this.d.contacts.get(row.contact_id);
    if (!s || !contact)
      return this.end(id, "contact_removed", say(tOf(s), !s ? "sessionGone" : "contactRemovedNotSent"));
    const params = JSON.parse(row.message);
    const extensions = JSON.parse(row.extensions) as string[];
    const traceparent = params.message?.metadata?.[A2A_EXT.trace]?.traceparent as string | undefined;
    let last: unknown = null;
    let reachable = false;
    for (const addr of this.addrsOf(contact, row.addr)) {
      const peer = this.peer(contact, addr, s);
      try {
        let card: PeerCard;
        if (row.iface && row.addr === addr.url) card = JSON.parse(row.iface);
        else {
          card = await peer.card(row.agent_id);
          if (this.closed) return;
          this.d.store.run(
            "UPDATE a2a_calls SET iface=?,addr=?,agent_name=? WHERE id=?",
            JSON.stringify(card),
            addr.url,
            line(card.name || row.agent_id, 80) || row.agent_id,
            id,
          );
        }
        const r = await peer.send(card, params, { extensions, ...(traceparent ? { traceparent } : {}) });
        if (this.closed) return;
        this.d.store.run("UPDATE a2a_calls SET addr=? WHERE id=?", addr.url, id);
        if ("task" in r) return this.apply(id, r.task);
        // A direct message (non-Daisy agents may answer so): the answer, done.
        return this.apply(id, null, partsText(r.message.parts));
      } catch (e) {
        if (this.closed) return;
        last = e;
        // Another address may do (offline here, or this address refused by our own rules).
        if (e instanceof PeerError && (e.kind === "unreachable" || e.kind === "refused")) {
          if (e.kind === "unreachable") reachable = true;
          continue;
        }
        // Busy (429 / 503): the same message again after its Retry-After — not now, no hot loop.
        if (e instanceof PeerError && e.kind === "busy") return this.later(row, e);
        return this.end(id, e instanceof PeerError ? (e.more.reason ?? e.kind) : "client_error", this.failureText(e, tOf(s), row));
      }
    }
    // Every address was refused by our rules: nothing to try again.
    if (!reachable) return this.end(id, "refused", this.failureText(last, tOf(s), row));
    // No address answered: the same message again later (same messageId), a few times.
    const failures = Number(row.failures) + 1;
    if (failures >= this.L.sendAttempts)
      return this.end(id, "unreachable", say(tOf(s), "offline", { n: failures, why: this.failureText(last, tOf(s)) }));
    const delay = this.nextDelay(Number(row.delay), "TASK_STATE_SUBMITTED");
    this.d.store.run("UPDATE a2a_calls SET failures=?,delay=?,next_at=?,updated=? WHERE id=?", failures, delay, this.now() + delay, this.now(), id);
  }

  /**
   * The other side said "not now" (429 RESOURCE_EXHAUSTED, 503 UNAVAILABLE):
   * try again after its Retry-After (at least the first poll wait, at most
   * the longest), a bounded number of times; the AI is told why.
   */
  private later(row: any, e: PeerError) {
    const t = tOf(this.sessionOf(row.session_id));
    const failures = Number(row.failures) + 1;
    const limit = row.state === SENDING ? this.L.sendAttempts : this.L.pollFailuresMax;
    if (failures >= limit)
      return this.end(row.id, e.more.reason ?? "busy", say(t, "busyGaveUp", { why: e.message, n: failures }));
    // Their Retry-After is honoured (up to a ceiling); without one, our own backoff.
    const wait =
      e.more.retryAfterS !== undefined
        ? Math.min(this.L.retryAfterMaxMs, Math.max(this.L.pollFirstMs, e.more.retryAfterS * 1000))
        : this.nextDelay(Number(row.delay), row.state);
    this.d.store.run(
      "UPDATE a2a_calls SET failures=?,delay=?,next_at=?,status_text=?,updated=? WHERE id=?",
      failures,
      wait,
      this.now() + wait,
      say(t, row.state === SENDING ? "busyResend" : "busyRecheck", { why: e.message, s: Math.ceil(wait / 1000) }),
      this.now(),
      row.id,
    );
  }

  private nextDelay(prev: number, state: string) {
    const max = state === "TASK_STATE_AUTH_REQUIRED" ? this.L.pollAuthMaxMs : this.L.pollMaxMs;
    return Math.min(max, prev ? Math.round(prev * this.L.pollFactor) : this.L.pollFirstMs);
  }

  /** Ask the other side how the task is (one GetTask). */
  private poll(id: string): Promise<void> {
    let p = this.inflight.get(id);
    if (!p) {
      p = this.pollNow(id)
        .catch((e) => log.warn("a2a client: polling failed", { call: id, error: String((e as Error)?.message ?? e).slice(0, 200) }))
        .finally(() => {
          this.inflight.delete(id);
          this.arm();
        });
      this.inflight.set(id, p);
    }
    return p;
  }

  private async pollNow(id: string) {
    const row = this.row(id);
    if (!row || settledState(row.state) || row.state === SENDING || this.closed) return;
    if (this.now() - row.created > this.L.callMaxMs)
      return this.end(id, "too_long", say(tOf(this.sessionOf(row.session_id)), "tooLong"));
    const s = this.sessionOf(row.session_id);
    const contact = this.d.contacts.get(row.contact_id);
    if (!s || !contact) return this.end(id, "contact_removed", say(tOf(s), !s ? "sessionGone" : "contactRemoved"));
    const addr = contact.addrs.find((x) => x.url === row.addr) ?? contact.addrs[0];
    if (!addr || !row.iface || !row.task_id) return this.end(id, "no_address", say(tOf(s), "addressGone"));
    try {
      const task = await this.peer(contact, addr, s).getTask(JSON.parse(row.iface), row.task_id);
      if (this.closed) return;
      this.apply(id, task);
    } catch (e) {
      if (this.closed) return;
      if (e instanceof PeerError && e.kind === "unreachable") {
        const failures = Number(row.failures) + 1;
        if (failures >= this.L.pollFailuresMax) return this.end(id, "unreachable", say(tOf(s), "unreachableGaveUp", { why: this.failureText(e, tOf(s)) }));
        const delay = this.nextDelay(Number(row.delay), row.state);
        this.d.store.run("UPDATE a2a_calls SET failures=?,delay=?,next_at=?,updated=? WHERE id=?", failures, delay, this.now() + delay, this.now(), id);
        return;
      }
      if (e instanceof PeerError && e.kind === "busy") return this.later(row, e);
      if (e instanceof PeerError && e.more.reason === "TASK_NOT_FOUND")
        return this.end(id, "task_gone", say(tOf(s), "taskGone"));
      return this.end(id, e instanceof PeerError ? (e.more.reason ?? e.kind) : "client_error", this.failureText(e, tOf(s), row));
    }
  }

  /** The other side's task (or a direct answer): record it, poll on, or hand it to the AI. */
  private apply(id: string, task: A2ATask | null, direct?: string) {
    const store = this.d.store;
    const row = this.row(id);
    if (!row) return;
    const now = this.now();
    if (!task) {
      store.run(
        "UPDATE a2a_calls SET state='TASK_STATE_COMPLETED',answer=?,next_at=NULL,failures=0,updated=? WHERE id=?",
        direct ?? "",
        now,
        id,
      );
      return this.settled(id);
    }
    // The ids are the other side's (opaque); a task id that changes under the same call is not ours to follow.
    if (row.task_id && row.task_id !== task.id) return this.end(id, "protocol", say(tOf(this.sessionOf(row.session_id)), "otherTask"));
    const st = task.status.state as TaskState;
    const statusParts = (task.status.message as any)?.parts;
    if (isTerminal(st) || st === "TASK_STATE_INPUT_REQUIRED") {
      const ans = st === "TASK_STATE_COMPLETED" ? answerOf(task) : { text: null, files: [] as string[] };
      store.run(
        "UPDATE a2a_calls SET context_id=?,task_id=?,state=?,reason=?,status_text=?,answer=?,files=?,next_at=NULL,failures=0,updated=? WHERE id=?",
        task.contextId,
        task.id,
        st,
        reasonOf(statusParts),
        partsText(statusParts, this.L.answerMax) || null,
        ans.text,
        ans.files.length ? JSON.stringify(ans.files) : null,
        now,
        id,
      );
      return this.settled(id);
    }
    const delay = row.state === st || row.state === SENDING ? this.nextDelay(Number(row.delay), st) : this.L.pollFirstMs;
    store.run(
      "UPDATE a2a_calls SET context_id=?,task_id=?,state=?,status_text=?,failures=0,delay=?,next_at=?,updated=? WHERE id=?",
      task.contextId,
      task.id,
      st,
      partsText(statusParts, 2000) || null,
      delay,
      now + delay,
      now,
      id,
    );
  }

  /** Ended here, without (more of) the other side's task. */
  private end(id: string, reason: string, text: string) {
    this.d.store.run(
      "UPDATE a2a_calls SET state=?,reason=?,status_text=?,next_at=NULL,updated=? WHERE id=?",
      ERROR,
      String(reason).slice(0, 60),
      text.slice(0, 2000),
      this.now(),
      id,
    );
    this.settled(id);
  }

  /** A settled state: audited; the AI woken once — unless its tool answer reports it now, or it already saw it. */
  private settled(id: string) {
    const row = this.row(id);
    if (!row) return;
    this.d.store.audit(`ai:${row.session_id}`, "a2a.call.settled", JSON.stringify({ call: id, state: row.state, reason: row.reason }), {
      actor: "system",
      object: `a2a-call:${id}`,
      traceId: row.trace_id,
      depth: row.depth,
      sessionId: row.session_id,
      outcome: row.state === "TASK_STATE_COMPLETED" || row.state === "TASK_STATE_INPUT_REQUIRED" ? "ok" : "error",
      ...(row.reason ? { reason: row.reason } : {}),
    });
    if (this.inline.has(id) || row.told === row.state) return;
    this.wake(row);
  }

  private wake(row: any) {
    const s = this.sessionOf(row.session_id);
    if (!s || s.deleting) return;
    const t = tOf(s);
    const source: Source =
      row.state === ERROR
        ? { kind: "system", name: say(t, "daisySource") }
        : { kind: "peer-ai", name: row.agent_name, owner: row.contact_name };
    const question = row.state === "TASK_STATE_INPUT_REQUIRED";
    const answered = row.state === "TASK_STATE_COMPLETED";
    const prompt =
      sourcePrompt({
        event: say(t, answered ? "event.answered" : question ? "event.question" : "event.failed"),
        source,
        ownerName: this.d.ownerName(),
        lang: sessionLang(s),
        outcome: answered || question ? "answer" : "failed",
        ...(answered || question ? {} : { failure: stateLabel(row.state, t) }),
        text: answered ? (row.answer ?? "") : (row.status_text ?? ""),
        meta: this.meta(row, t),
      }) +
      `\n${say(t, "daisyNote", { step: this.nextStep(row, t) })}`;
    const n = Number(row.wakes) + 1;
    this.d.store.run("UPDATE a2a_calls SET told=?,wakes=? WHERE id=?", row.state, n, row.id);
    // trace.md §3: the answer continues the caller's trace, at the caller's depth.
    this.d.wakes.queue(
      s.id,
      `a2a:${row.id}:${n}`,
      prompt,
      { type: "peer-reply", senderName: flat(row.agent_name, 80), senderKind: "agent" },
      { traceId: row.trace_id, depth: Math.max(0, Number(row.depth) - 1) },
    );
  }

  private meta(row: any, t: Translate): Record<string, unknown> {
    return {
      call: row.id,
      agent: row.agent_id,
      contact: row.contact_id,
      state: row.state,
      ...(row.reason ? { reason: row.reason } : {}),
      ...(row.context_id ? { contextId: row.context_id } : {}),
      ...(row.task_id ? { taskId: row.task_id } : {}),
      ...(row.files ? { files: JSON.parse(row.files), filesNote: say(t, "filesNotFetched") } : {}),
    };
  }

  private nextStep(row: any, t: Translate): string {
    switch (row.state) {
      case "TASK_STATE_INPUT_REQUIRED":
        return say(t, "next.reply", { id: row.id });
      case "TASK_STATE_COMPLETED":
        return say(t, "next.continue", { contact: row.contact_id, agent: row.agent_id });
      default:
        return say(t, row.reason === "INPUT_EXPIRED" ? "next.inputExpired" : "next.default");
    }
  }

  /** What the AI is told about a call (the tool's answer, call_result). */
  private describe(row: any, t: Translate): string {
    const head = say(t, "head", {
      id: row.id,
      contact: line(row.contact_name, 60),
      agent: line(row.agent_name, 60),
      mode: say(t, row.mode === "act" ? "mode.act" : "mode.ask"),
      state: stateLabel(row.state, t),
    });
    const ids = row.task_id ? `\n${say(t, "ids", { task: flat(row.task_id, 200), context: flat(row.context_id, 200) })}` : "";
    const body = (() => {
      switch (row.state) {
        case "TASK_STATE_COMPLETED":
          return `\n${say(t, "body.answer")}\n${external({ ...this.meta(row, t), text: row.answer ?? "" })}\n${this.nextStep(row, t)}`;
        case "TASK_STATE_INPUT_REQUIRED":
          return `\n${say(t, "body.question")}\n${external({ ...this.meta(row, t), text: row.status_text ?? "" })}\n${this.nextStep(row, t)}`;
        case "TASK_STATE_REJECTED":
        case "TASK_STATE_FAILED":
        case "TASK_STATE_CANCELED":
          return `\n${say(t, "body.reason")}\n${external({ ...this.meta(row, t), text: row.status_text ?? "" })}\n${this.nextStep(row, t)}`;
        case ERROR:
          return `\n${row.status_text ?? ""}`;
        case "TASK_STATE_AUTH_REQUIRED":
          return `\n${say(t, "body.auth")}`;
        default:
          return `${row.status_text && (row.state === SENDING || Number(row.failures) > 0) ? `\n${row.status_text}` : ""}\n${say(t, "body.pending")}`;
      }
    })();
    return head + ids + body;
  }

  /** Our words for a failure (the remote's own message, if any, marked as theirs). */
  private failureText(e: unknown, t: Translate, row?: any): string {
    if (!(e instanceof PeerError)) return say(t, "fail.generic");
    const reason = e.more.reason;
    const ours =
      reason === "CONTEXT_NOT_FOUND"
        ? say(t, "fail.contextGone")
        : reason === "MESSAGE_ID_CONFLICT"
          ? say(t, "fail.conflict")
          : reason === "TASK_NOT_FOUND"
            ? say(t, "fail.noTask")
            : reason === "UNSUPPORTED_OPERATION" && row?.task_id
              ? say(t, "fail.notTakingInput")
              : e.message;
    return e.more.remoteMessage ? `${ours}\n${say(t, "fail.remote")}\n${external({ text: e.more.remoteMessage })}` : ours;
  }

  // ── call_result (查询调用结果) ──────────────────────────────────────────
  async result(s: Session, body: any): Promise<{ ok: true; text: string }> {
    const t = tOf(s);
    const { jobId: _j, ...rest } = body ?? {};
    const a = ResultArgs.safeParse(rest);
    if (!a.success) throw new HttpError(400, zodMessage(a.error, t), "invalid_input");
    const store = this.d.store;
    if (!a.data.callId) {
      const rows = store.all("SELECT * FROM a2a_calls WHERE session_id=? ORDER BY created DESC LIMIT 20", s.id);
      if (!rows.length) return { ok: true, text: say(t, "none") };
      return {
        ok: true,
        text: [
          say(t, "recent"),
          ...rows.map((r: any) =>
            say(t, "recentRow", {
              id: r.id,
              contact: line(r.contact_name, 40),
              agent: line(r.agent_name, 40),
              mode: say(t, r.mode === "act" ? "mode.act" : "mode.ask"),
              state: stateLabel(r.state, t),
              at: new Date(r.created).toISOString(),
            }),
          ),
        ].join("\n"),
      };
    }
    let row = store.one("SELECT * FROM a2a_calls WHERE id=? AND session_id=?", a.data.callId, s.id);
    if (!row) throw new HttpError(404, say(t, "resultNotFound"), "call_not_found");
    if (!settledState(row.state)) {
      // Ask once now (bounded), not only when the next poll is due.
      this.inline.add(row.id);
      try {
        await Promise.race([row.state === SENDING ? this.deliver(row.id) : this.poll(row.id), sleep(this.L.inlineWaitMs)]);
      } finally {
        this.inline.delete(row.id);
      }
      row = this.row(row.id);
    }
    // The AI has seen this state now: no wake for it.
    if (settledState(row.state)) store.run("UPDATE a2a_calls SET told=? WHERE id=?", row.state, row.id);
    return { ok: true, text: this.describe(row, t) };
  }

  // ── the schedule ────────────────────────────────────────────────────────
  /** Set the timer for the next due call. */
  private arm() {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    let next: number | null;
    try {
      next = this.d.store.one("SELECT MIN(next_at) t FROM a2a_calls WHERE next_at IS NOT NULL")?.t ?? null;
    } catch {
      return; // the store is closing
    }
    if (next === null) return;
    const wait = Math.max(10, Math.min(60_000, next - this.now()));
    const t = setTimeout(() => this.tick(), wait);
    (t as unknown as { unref?: () => void }).unref?.();
    this.timer = t;
  }

  /** Every call due now: resend, or poll. */
  tick() {
    this.timer = null;
    if (this.closed) return;
    let due: any[];
    try {
      due = this.d.store.all("SELECT id,state FROM a2a_calls WHERE next_at IS NOT NULL AND next_at<=? ORDER BY next_at LIMIT 20", this.now());
    } catch {
      return;
    }
    for (const r of due) {
      if (this.inflight.has(r.id)) {
        this.d.store.run("UPDATE a2a_calls SET next_at=? WHERE id=?", this.now() + 1000, r.id);
        continue;
      }
      // Taken now; the next time is set when it answers.
      this.d.store.run("UPDATE a2a_calls SET next_at=NULL WHERE id=?", r.id);
      if (r.state === SENDING) void this.deliver(r.id);
      else void this.poll(r.id);
    }
    this.arm();
  }
}
