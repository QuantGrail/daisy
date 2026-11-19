/**
 * P4-09 (ADR-128 §5): the three tools, as P4-08 has them in Daisy (ADR-127
 * §2) — 发现智能体 `agents`, 调用智能体 `call_agent`, 查询调用结果
 * `call_result` — for a harness that does not run Daisy.
 *
 * Who calls: this MCP's own identity — a token it signs per request
 * (token.md §3 / §5, shared `signA2AToken`: `client_id` a2a, `sub` = `iss` =
 * this MCP, `aud` exactly the contact, 120 s, a fresh `jti`; `act` = the
 * harness's AI). Tokens are never kept.
 *
 * The three ids (D-16, 5.8 「私人 agent 经独立的 A2A MCP 调用别人：同上，由那个
 * MCP 记下编号」): the remote's contextId / taskId are kept per call
 * (`calls/<id>.json`), opaque; `continue` sends the last contextId with that
 * agent; `replyTo` answers an input-required question on the same task.
 * The exact message is kept with its messageId: an address that did not
 * answer is tried again with the same message (原则 2), a few times.
 *
 * The trace (trace.md): this MCP is where a chain starts — every call is a
 * new trace at depth 1 (nothing ever calls in, so no turn is deeper);
 * `replyTo` keeps the call's trace and depth.
 *
 * Unlike Daisy there is no one to wake: `call_agent` waits a little for the
 * answer (polling), then hands back the call id; `call_result` asks the other
 * side again (bounded) and reports. Everything the other side wrote goes to
 * the AI inside <external_message> (JSON, `<` `>` escaped), marked as
 * reference material, not instructions.
 *
 * Every connection: packages/a2a-client net.ts (SSRF rules, pinned address,
 * no redirects, caps, timeouts) — loopback refused unless a test relaxes it.
 */
import { randomUUID, randomBytes } from "node:crypto";
import { z } from "zod";
import { A2A_EXT, isTerminal, type A2ATask, type TaskState } from "../../contracts/src/a2a.ts";
import { A2A_CLIENT_LIMITS, A2A_LIMITS } from "../../contracts/src/limits.ts";
import { MCP_COMMAND_NAME, MCP_NAME } from "../../contracts/src/names.ts";
import { KeyedError, pt } from "../../contracts/src/i18n-process.ts";
import type { MessageKey } from "../../contracts/src/i18n.ts";
import type { CardAddress } from "../../contracts/src/api/contacts.ts";
import {
  A2APeer,
  PeerError,
  UNSAFE_TEXT,
  answerOf,
  partsText,
  reasonOf,
  bindingVerifierFor,
  type OutboundPolicy,
  type PeerCard,
  type TlsBindingVerifier,
} from "../../a2a-client/src/index.ts";
import type { Home } from "./home.ts";
import type { McpIdentity } from "./identity.ts";
import type { AddressBook, McpContact } from "./contacts.ts";

export type Limits = { -readonly [K in keyof typeof A2A_CLIENT_LIMITS]: number };

const SENDING = "sending";
const ERROR = "error";
const settledState = (s: string) => s === ERROR || s === "TASK_STATE_INPUT_REQUIRED" || isTerminal(s);

const STATE_LABEL: Record<string, MessageKey> = {
  sending: "mcp.state.sending",
  error: "mcp.state.error",
  TASK_STATE_SUBMITTED: "mcp.state.submitted",
  TASK_STATE_WORKING: "mcp.state.working",
  TASK_STATE_INPUT_REQUIRED: "mcp.state.inputRequired",
  TASK_STATE_AUTH_REQUIRED: "mcp.state.authRequired",
  TASK_STATE_COMPLETED: "mcp.state.completed",
  TASK_STATE_FAILED: "mcp.state.failed",
  TASK_STATE_CANCELED: "mcp.state.canceled",
  TASK_STATE_REJECTED: "mcp.state.rejected",
};
const stateLabel = (s: string) => (STATE_LABEL[s] ? pt.dynamic(STATE_LABEL[s]) : s);
const modeLabel = (m: string) => pt(m === "act" ? "mcp.mode.act" : "mcp.mode.ask");

/*
 * The tools' arguments (P6-23b: their descriptions in this process's
 * language — built when the server registers the tools, after the command
 * settled its language).
 */
export const callArgs = () => ({
  contact: z.string().trim().min(1).max(200).optional().describe(pt("mcp.arg.call.contact")),
  agent: z.string().trim().min(1).max(A2A_LIMITS.idMax).optional().describe(pt("mcp.arg.call.agent")),
  text: z.string().min(1).max(A2A_CLIENT_LIMITS.textMax).describe(pt("mcp.arg.call.text")),
  mode: z.enum(["ask", "act"]).default("ask").describe(pt("mcp.arg.call.mode")),
  continue: z.boolean().default(false).describe(pt("mcp.arg.call.continue")),
  replyTo: z.string().trim().min(1).max(100).optional().describe(pt("mcp.arg.call.replyTo")),
});
export const agentsArgs = () => ({
  contact: z.string().trim().min(1).max(200).optional().describe(pt("mcp.arg.agents.contact")),
});
export const resultArgs = () => ({
  callId: z.string().trim().min(1).max(100).optional().describe(pt("mcp.arg.result.callId")),
});

/** A tool's failure: its text (a message key) goes to the AI as an error result. */
export class ToolError extends KeyedError {
  constructor(
    key: MessageKey,
    params: Record<string, string | number> = {},
    readonly code: string = "error",
  ) {
    super(key, params);
  }
}

/** One call, as kept in calls/<id>.json. */
interface CallRow {
  id: string;
  contactId: string;
  contactName: string;
  agentId: string;
  agentName: string;
  mode: "ask" | "act";
  messageId: string;
  /** The SendMessage params, exactly as sent (a resend sends the same). */
  message: any;
  extensions: string[];
  contextId: string | null;
  taskId: string | null;
  state: string;
  reason: string | null;
  statusText: string | null;
  answer: string | null;
  files: string[] | null;
  traceId: string;
  depth: number;
  addr: string | null;
  iface: Pick<PeerCard, "binding" | "url"> | null;
  failures: number;
  delay: number;
  nextAt: number | null;
  created: number;
  updated: number;
}

const clean = (x: string) => x.replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
function flat(x: unknown, n = 80) {
  const t = String(x ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[<>【】]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}
const line = (x: unknown, n = 80) => flat(String(x ?? "").replace(/[「『]/g, "“").replace(/[」』]/g, "”"), n);
/** Remote-provided content, for the AI: data inside the tags, never instructions. */
const external = (fields: Record<string, unknown>) => `<external_message>\n${clean(JSON.stringify(fields))}\n</external_message>`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** W3C trace context (trace.md §2): a new trace id / span id. */
const newTraceId = () => randomBytes(16).toString("hex");
const traceparent = (traceId: string) => `00-${traceId}-${randomBytes(8).toString("hex")}-01`;

/** How many kept calls; the oldest settled ones go first. */
const KEEP_CALLS = 500;

export interface ClientOptions {
  home: Home;
  self: McpIdentity;
  book: AddressBook;
  /** `act.name`: what the other owner sees as the calling AI. */
  agentName?: string;
  /** Tests only: loopback allowed, a stand-in resolver. */
  policy?: OutboundPolicy;
  limits?: Partial<Limits>;
}

export class McpClient {
  private L: Limits;
  /** One send / poll at a time per call (in this process). */
  private inflight = new Map<string, Promise<void>>();
  private act: { sub: string; name: string };

  constructor(private o: ClientOptions) {
    this.L = { ...A2A_CLIENT_LIMITS, ...o.limits };
    const name = String(o.agentName ?? MCP_NAME)
      .replace(new RegExp(UNSAFE_TEXT.source, "g"), "")
      .trim()
      .slice(0, 64);
    this.act = { sub: `agent:${MCP_COMMAND_NAME}`, name: name || MCP_NAME };
  }

  // ── the calls kept ──────────────────────────────────────────────────────
  private file(id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new ToolError("mcp.error.badCallId", {}, "call_not_found");
    return `calls/${id}.json`;
  }
  private row(id: string): CallRow | null {
    return this.o.home.readJson<CallRow | null>(this.file(id), null);
  }
  private put(r: CallRow) {
    r.updated = Date.now();
    this.o.home.writeJson(this.file(r.id), r);
  }
  private update(id: string, patch: Partial<CallRow>): CallRow | null {
    const r = this.row(id);
    if (!r) return null;
    Object.assign(r, patch);
    this.put(r);
    return r;
  }
  private rows(): CallRow[] {
    const out: CallRow[] = [];
    for (const f of this.o.home.list("calls")) {
      const m = /^([0-9a-f-]{36})\.json$/.exec(f);
      if (!m) continue;
      try {
        const r = this.row(m[1]!);
        if (r) out.push(r);
      } catch {
        // unreadable: skipped
      }
    }
    return out.sort((a, b) => b.created - a.created);
  }
  private prune() {
    const all = this.rows();
    let extra = all.length - KEEP_CALLS;
    if (extra <= 0) return;
    // The oldest settled calls go first (rows() is newest first).
    for (const r of all.filter((x) => settledState(x.state)).reverse()) {
      if (extra-- <= 0) break;
      this.o.home.remove(this.file(r.id));
    }
  }

  // ── contacts and peers ──────────────────────────────────────────────────
  private async contact(ref: string): Promise<McpContact> {
    const found = await this.o.book.find(ref);
    if (found.length === 1) return found[0]!;
    throw new ToolError(found.length > 1 ? "mcp.error.contactAmbiguous" : "mcp.error.contactNotFound", {}, "contact_not_found");
  }

  /** P5-02 (ADR-100): each contact's TLS binding claims (its key from the address book). */
  private bindings = new Map<string, TlsBindingVerifier>();

  private peer(c: McpContact, addr: CardAddress): A2APeer {
    let v = this.bindings.get(`${c.id}:${c.key.x}`);
    if (!v) {
      if (this.bindings.size > 256) this.bindings.clear();
      v = bindingVerifierFor(c.key, "relay", this.o.policy);
      this.bindings.set(`${c.id}:${c.key.x}`, v);
    }
    return new A2APeer({
      root: addr.url,
      kind: addr.kind,
      token: () => this.o.self.token(c.urn, this.act),
      ...(this.o.policy ? { policy: this.o.policy } : {}),
      tlsCheck: (seen) => this.o.book.tlsCheck(c, seen),
      // A relay address: no token before the other Daisy's claim checks out.
      binding: { verifier: v },
    });
  }

  // ── agents (发现智能体) ─────────────────────────────────────────────────
  async agents(args: { contact?: string | undefined }): Promise<string> {
    const all = args.contact ? [await this.contact(args.contact)] : await this.o.book.list();
    if (!all.length)
      return pt("mcp.agents.empty", { cmd: MCP_COMMAND_NAME });
    const list = all.slice(0, this.L.discoverContactsMax);
    type Found = { c: McpContact; agents?: { agentId: string; name: string }[]; note?: string };
    const one = async (c: McpContact): Promise<Found> => {
      if (!c.addrs.length) return { c, note: pt("mcp.agents.noAddress") };
      let last: unknown = null;
      for (const addr of c.addrs) {
        try {
          return { c, agents: await this.peer(c, addr).directory() };
        } catch (e) {
          last = e;
          if (!(e instanceof PeerError) || e.kind !== "unreachable") break;
        }
      }
      return { c, note: this.failureText(last) };
    };
    const timeout = sleep(this.L.discoverTimeoutMs + 1500).then(() => null);
    const results = await Promise.all(
      list.map((c) =>
        Promise.race([one(c).catch((e): Found => ({ c, note: this.failureText(e) })), timeout]).then(
          (r): Found => r ?? { c, note: pt("mcp.agents.noAnswer") },
        ),
      ),
    );
    const out: string[] = [pt("mcp.agents.head"), pt("mcp.agents.howToCall")];
    for (const r of results) {
      out.push(`\n${pt("mcp.agents.contact", { name: line(r.c.name, 60), id: r.c.id })}`);
      if (r.agents) {
        if (!r.agents.length) out.push(`  ${pt("mcp.agents.none")}`);
        else out.push(external({ agents: r.agents.map((x) => ({ agentId: x.agentId, name: x.name })) }));
      } else out.push(`  ${r.note}`);
    }
    if (all.length > list.length) out.push(`\n${pt("mcp.agents.more", { n: list.length })}`);
    return out.join("\n");
  }

  // ── call_agent (调用智能体) ─────────────────────────────────────────────
  async call(a: {
    contact?: string | undefined;
    agent?: string | undefined;
    text: string;
    mode: "ask" | "act";
    continue: boolean;
    replyTo?: string | undefined;
  }): Promise<{ ok: boolean; text: string; call: { id: string; state: string } }> {
    let r: CallRow;
    let note = "";
    if (a.replyTo) {
      const row = this.row(a.replyTo);
      if (!row) throw new ToolError("mcp.error.noSuchReplyTo", {}, "call_not_found");
      if (row.state !== "TASK_STATE_INPUT_REQUIRED" || this.inflight.has(row.id))
        throw new ToolError("mcp.error.notInputRequired", { state: stateLabel(row.state) }, "not_input_required");
      // trace.md §3: the answer keeps the task's trace and depth.
      const m = this.message({ ...a, traceId: row.traceId, depth: row.depth, contextId: row.contextId, taskId: row.taskId });
      r = Object.assign(row, {
        messageId: m.params.message.messageId,
        message: m.params,
        extensions: m.extensions,
        mode: a.mode,
        state: SENDING,
        reason: null,
        statusText: null,
        answer: null,
        files: null,
        failures: 0,
        delay: 0,
        nextAt: null,
      });
    } else {
      if (!a.contact || !a.agent)
        throw new ToolError("mcp.error.needContactAgent");
      const contact = await this.contact(a.contact);
      if (!contact.addrs.length) throw new ToolError("mcp.error.noAddress", {}, "no_address");
      const rows = this.rows();
      const open = rows.filter((x) => !settledState(x.state)).length;
      if (open >= this.L.openPerSession)
        throw new ToolError("mcp.error.tooManyCalls", { open }, "too_many_calls");
      let contextId: string | null = null;
      if (a.continue) {
        contextId = rows.find((x) => x.contactId === contact.id && x.agentId === a.agent && x.contextId)?.contextId ?? null;
        if (!contextId) note = pt("mcp.call.newContext");
      }
      // This MCP starts the chain: a new trace, depth 1 (trace.md §3).
      const traceId = newTraceId();
      const m = this.message({ ...a, traceId, depth: 1, contextId, taskId: null });
      const now = Date.now();
      r = {
        id: randomUUID(),
        contactId: contact.id,
        contactName: contact.name,
        agentId: a.agent,
        agentName: a.agent,
        mode: a.mode,
        messageId: m.params.message.messageId,
        message: m.params,
        extensions: m.extensions,
        contextId,
        taskId: null,
        state: SENDING,
        reason: null,
        statusText: null,
        answer: null,
        files: null,
        traceId,
        depth: 1,
        addr: null,
        iface: null,
        failures: 0,
        delay: 0,
        nextAt: null,
        created: now,
        updated: now,
      };
    }
    this.put(r);
    this.prune();
    await this.settle(r.id, this.L.inlineWaitMs);
    const row = this.row(r.id)!;
    return {
      ok: row.state !== ERROR && row.state !== "TASK_STATE_REJECTED" && row.state !== "TASK_STATE_FAILED",
      text: this.describe(row) + note,
      call: { id: row.id, state: row.state },
    };
  }

  /** The SendMessage params and the extensions to enable (a2a-usage.md §8, trace.md §4). */
  private message(o: { text: string; mode: "ask" | "act"; traceId: string; depth: number; contextId: string | null; taskId: string | null }) {
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
          [A2A_EXT.trace]: { traceparent: traceparent(o.traceId), depth: o.depth },
          ...(o.mode === "act" ? { [A2A_EXT.act]: { mode: "act" } } : {}),
        },
      },
      configuration: { returnImmediately: true, acceptedOutputModes: ["text/plain"] },
    };
    return { params, extensions };
  }

  /**
   * Send (or resend) / poll until the call settles or `budgetMs` is spent —
   * honouring the other side's Retry-After and our own backoff (never a hot
   * loop): what the tools wait for before they answer.
   */
  private async settle(id: string, budgetMs: number) {
    const end = Date.now() + budgetMs;
    let wait = Math.min(500, this.L.pollFirstMs);
    for (;;) {
      const r = this.row(id);
      if (!r || settledState(r.state)) return;
      if (Date.now() - r.created > this.L.callMaxMs)
        return this.end(id, "too_long", pt("mcp.call.tooLong"));
      if (!r.nextAt || r.nextAt <= Date.now()) await this.step(id);
      const after = this.row(id);
      if (!after || settledState(after.state)) return;
      const due = after.nextAt ? Math.max(0, after.nextAt - Date.now()) : wait;
      const left = end - Date.now();
      if (left <= 0 || due > left) return;
      await sleep(Math.max(50, Math.min(due || wait, left)));
      wait = Math.min(Math.round(wait * this.L.pollFactor), this.L.pollMaxMs);
    }
  }

  /** One send or one poll (one at a time per call). */
  private step(id: string): Promise<void> {
    let p = this.inflight.get(id);
    if (!p) {
      const r = this.row(id);
      p = (r?.state === SENDING ? this.sendNow(id) : this.pollNow(id))
        .catch((e) => {
          this.end(id, "client_error", pt("mcp.call.clientError", { why: String((e as Error)?.message ?? e).slice(0, 200) }));
        })
        .finally(() => this.inflight.delete(id));
      this.inflight.set(id, p);
    }
    return p;
  }

  private addrsOf(c: McpContact, prefer: string | null): CardAddress[] {
    return c.addrs.slice().sort((x, y) => Number(y.url === prefer) - Number(x.url === prefer));
  }

  private async sendNow(id: string) {
    const row = this.row(id);
    if (!row || row.state !== SENDING) return;
    const contact = await this.o.book.get(row.contactId);
    if (!contact) return this.end(id, "contact_removed", pt("mcp.call.contactRemovedUnsent"));
    const traceHeader = row.message?.message?.metadata?.[A2A_EXT.trace]?.traceparent as string | undefined;
    let last: unknown = null;
    let reachable = false;
    for (const addr of this.addrsOf(contact, row.addr)) {
      const peer = this.peer(contact, addr);
      try {
        let card: Pick<PeerCard, "binding" | "url">;
        if (row.iface && row.addr === addr.url) card = row.iface;
        else {
          const full = await peer.card(row.agentId);
          card = { binding: full.binding, url: full.url };
          this.update(id, { iface: card, addr: addr.url, agentName: line(full.name || row.agentId, 80) || row.agentId });
        }
        const r = await peer.send(card, row.message, { extensions: row.extensions, ...(traceHeader ? { traceparent: traceHeader } : {}) });
        this.update(id, { addr: addr.url });
        if ("task" in r) return this.apply(id, r.task);
        return this.apply(id, null, partsText(r.message.parts));
      } catch (e) {
        last = e;
        if (e instanceof PeerError && (e.kind === "unreachable" || e.kind === "refused")) {
          if (e.kind === "unreachable") reachable = true;
          continue;
        }
        if (e instanceof PeerError && e.kind === "busy") return this.later(row, e);
        return this.end(id, e instanceof PeerError ? (e.more.reason ?? e.kind) : "client_error", this.failureText(e, row));
      }
    }
    if (!reachable) return this.end(id, "refused", this.failureText(last, row));
    const failures = row.failures + 1;
    if (failures >= this.L.sendAttempts)
      return this.end(id, "unreachable", pt("mcp.call.unreachable", { n: failures, why: this.failureText(last) }));
    const delay = this.nextDelay(row.delay, "TASK_STATE_SUBMITTED");
    this.update(id, {
      failures,
      delay,
      nextAt: Date.now() + delay,
      statusText: pt("mcp.call.retryLater", { s: Math.ceil(delay / 1000) }),
    });
  }

  /** "Not now" (429 / 503): again after their Retry-After, a bounded number of times. */
  private later(row: CallRow, e: PeerError) {
    const failures = row.failures + 1;
    const limit = row.state === SENDING ? this.L.sendAttempts : this.L.pollFailuresMax;
    if (failures >= limit)
      return this.end(row.id, e.more.reason ?? "busy", pt("mcp.call.busyGaveUp", { why: e.message, n: failures }));
    const wait =
      e.more.retryAfterS !== undefined
        ? Math.min(this.L.retryAfterMaxMs, Math.max(this.L.pollFirstMs, e.more.retryAfterS * 1000))
        : this.nextDelay(row.delay, row.state);
    this.update(row.id, {
      failures,
      delay: wait,
      nextAt: Date.now() + wait,
      statusText: pt(row.state === SENDING ? "mcp.call.busyResend" : "mcp.call.busyPoll", { why: e.message, s: Math.ceil(wait / 1000) }),
    });
  }

  private nextDelay(prev: number, state: string) {
    const max = state === "TASK_STATE_AUTH_REQUIRED" ? this.L.pollAuthMaxMs : this.L.pollMaxMs;
    return Math.min(max, prev ? Math.round(prev * this.L.pollFactor) : this.L.pollFirstMs);
  }

  private async pollNow(id: string) {
    const row = this.row(id);
    if (!row || settledState(row.state) || row.state === SENDING) return;
    const contact = await this.o.book.get(row.contactId);
    if (!contact) return this.end(id, "contact_removed", pt("mcp.call.contactRemoved"));
    const addr = contact.addrs.find((x) => x.url === row.addr) ?? contact.addrs[0];
    if (!addr || !row.iface || !row.taskId) return this.end(id, "no_address", pt("mcp.call.addressGone"));
    try {
      this.apply(id, await this.peer(contact, addr).getTask(row.iface, row.taskId));
    } catch (e) {
      if (e instanceof PeerError && e.kind === "unreachable") {
        const failures = row.failures + 1;
        if (failures >= this.L.pollFailuresMax) return this.end(id, "unreachable", pt("mcp.call.pollUnreachable", { why: this.failureText(e) }));
        const delay = this.nextDelay(row.delay, row.state);
        this.update(id, { failures, delay, nextAt: Date.now() + delay });
        return;
      }
      if (e instanceof PeerError && e.kind === "busy") return this.later(row, e);
      if (e instanceof PeerError && e.more.reason === "TASK_NOT_FOUND")
        return this.end(id, "task_gone", pt("mcp.call.taskGone"));
      return this.end(id, e instanceof PeerError ? (e.more.reason ?? e.kind) : "client_error", this.failureText(e, row));
    }
  }

  /** The other side's task (or a direct answer): recorded; settled or polled on. */
  private apply(id: string, task: A2ATask | null, direct?: string) {
    const row = this.row(id);
    if (!row) return;
    if (!task) {
      this.update(id, { state: "TASK_STATE_COMPLETED", answer: direct ?? "", nextAt: null, failures: 0 });
      return;
    }
    if (row.taskId && row.taskId !== task.id) return this.end(id, "protocol", pt("mcp.call.otherTask"));
    const st = task.status.state as TaskState;
    const statusParts = (task.status.message as any)?.parts;
    if (isTerminal(st) || st === "TASK_STATE_INPUT_REQUIRED") {
      const ans = st === "TASK_STATE_COMPLETED" ? answerOf(task) : { text: null, files: [] as string[] };
      this.update(id, {
        contextId: task.contextId,
        taskId: task.id,
        state: st,
        reason: reasonOf(statusParts),
        statusText: partsText(statusParts, this.L.answerMax) || null,
        answer: ans.text,
        files: ans.files.length ? ans.files : null,
        nextAt: null,
        failures: 0,
      });
      return;
    }
    // Still going: asked again by the waiting tool (its own pace) or by call_result — no timer here.
    this.update(id, {
      contextId: task.contextId,
      taskId: task.id,
      state: st,
      statusText: partsText(statusParts, 2000) || null,
      failures: 0,
      delay: 0,
      nextAt: null,
    });
  }

  private end(id: string, reason: string, text: string) {
    this.update(id, { state: ERROR, reason: String(reason).slice(0, 60), statusText: text.slice(0, 2000), nextAt: null });
  }

  private meta(r: CallRow): Record<string, unknown> {
    return {
      call: r.id,
      agent: r.agentId,
      contact: r.contactId,
      state: r.state,
      ...(r.reason ? { reason: r.reason } : {}),
      ...(r.contextId ? { contextId: r.contextId } : {}),
      ...(r.taskId ? { taskId: r.taskId } : {}),
      ...(r.files ? { files: r.files, filesNote: pt("mcp.call.filesNotFetched") } : {}),
    };
  }

  private nextStep(r: CallRow): string {
    switch (r.state) {
      case "TASK_STATE_INPUT_REQUIRED":
        return pt("mcp.next.reply", { id: r.id });
      case "TASK_STATE_COMPLETED":
        return pt("mcp.next.continue", { contact: r.contactId, agent: r.agentId });
      default:
        return pt(r.reason === "INPUT_EXPIRED" ? "mcp.next.inputExpired" : "mcp.next.noBlindRetry");
    }
  }

  /** What the AI is told about a call (the tools' answers). */
  private describe(r: CallRow): string {
    const head = pt("mcp.describe.head", {
      id: r.id,
      contact: line(r.contactName, 60),
      agent: line(r.agentName, 60),
      mode: modeLabel(r.mode),
      state: stateLabel(r.state),
    });
    const ids = r.taskId ? `\n${pt("mcp.describe.ids", { task: flat(r.taskId, 200), context: flat(r.contextId, 200) })}` : "";
    const body = (() => {
      switch (r.state) {
        case "TASK_STATE_COMPLETED":
          return `\n${pt("mcp.describe.answer")}\n${external({ ...this.meta(r), text: r.answer ?? "" })}\n${this.nextStep(r)}`;
        case "TASK_STATE_INPUT_REQUIRED":
          return `\n${pt("mcp.describe.question")}\n${external({ ...this.meta(r), text: r.statusText ?? "" })}\n${this.nextStep(r)}`;
        case "TASK_STATE_REJECTED":
        case "TASK_STATE_FAILED":
        case "TASK_STATE_CANCELED":
          return `\n${pt("mcp.describe.reason")}\n${external({ ...this.meta(r), text: r.statusText ?? "" })}\n${this.nextStep(r)}`;
        case ERROR:
          return `\n${r.statusText ?? ""}`;
        case "TASK_STATE_AUTH_REQUIRED":
          return `\n${pt("mcp.describe.authRequired", { id: r.id })}`;
        default:
          return `${r.statusText && (r.state === SENDING || r.failures > 0) ? `\n${r.statusText}` : ""}\n${pt("mcp.describe.pending", { id: r.id })}`;
      }
    })();
    return head + ids + body;
  }

  private failureText(e: unknown, row?: CallRow): string {
    if (!(e instanceof PeerError)) return pt("mcp.failure.generic");
    const reason = e.more.reason;
    const ours =
      reason === "CONTEXT_NOT_FOUND"
        ? pt("mcp.failure.contextGone")
        : reason === "MESSAGE_ID_CONFLICT"
          ? pt("mcp.failure.messageIdConflict")
          : reason === "TASK_NOT_FOUND"
            ? pt("mcp.failure.taskNotFound")
            : reason === "UNSUPPORTED_OPERATION" && row?.taskId
              ? pt("mcp.failure.noInputNow")
              : e.message;
    return e.more.remoteMessage ? `${ours}\n${pt("mcp.failure.remoteNote")}\n${external({ text: e.more.remoteMessage })}` : ours;
  }

  // ── call_result (查询调用结果) ──────────────────────────────────────────
  async result(a: { callId?: string | undefined }): Promise<string> {
    if (!a.callId) {
      const rows = this.rows().slice(0, 20);
      if (!rows.length) return pt("mcp.result.none");
      return [
        pt("mcp.result.head"),
        ...rows.map((r) =>
          pt("mcp.result.row", {
            id: r.id,
            contact: line(r.contactName, 40),
            agent: line(r.agentName, 40),
            mode: modeLabel(r.mode),
            state: stateLabel(r.state),
            at: new Date(r.created).toISOString(),
          }),
        ),
      ].join("\n");
    }
    const row = this.row(a.callId);
    if (!row) throw new ToolError("mcp.error.noSuchCallId", {}, "call_not_found");
    if (!settledState(row.state)) await this.settle(row.id, this.L.inlineWaitMs);
    return this.describe(this.row(row.id)!);
  }
}
