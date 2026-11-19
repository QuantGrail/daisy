/**
 * P4-08 (ADR-127 §3, a2a-usage.md §15): the A2A 1.0 client half — one
 * other Daisy at one address. Shared with P4-09's standalone MCP (ADR-128;
 * moved here from packages/daisy/src/a2a/client/): it knows
 * nothing about stores, sessions or contacts; the caller gives the root
 * address, its kind, and a function that signs a fresh token per request.
 *
 * - Directory (`GET <root>/a2a`, not part of A2A), the agent's card,
 *   SendMessage, GetTask, CancelTask. Transport per the card: JSON-RPC
 *   first, HTTP+JSON when that is all it offers; `A2A-Version: 1.0` on
 *   every operation.
 * - The card is only believed about the same origin it was read from: an
 *   interface URL elsewhere is refused (our token, addressed to that
 *   Daisy, is never sent to another host the card names).
 * - Everything the other side says is data: parsed with size limits,
 *   shapes checked, strings capped; the remote's error messages are kept
 *   apart (`remoteMessage`) for the caller to mark as external.
 * - Every connection: net.ts (SSRF rules, pinned address, no redirects,
 *   caps, time limits).
 * - P5-02 (ADR-100, ADR-144): a relay address is never called without
 *   `binding` — every connection that would carry a token is first held
 *   against the other Daisy's TLS binding claim (binding.ts), verified
 *   with its key from the address book. No claim, a bad one, or one that
 *   does not name this certificate's key: nothing is sent.
 */
import { KeyedError, pt } from "../../contracts/src/i18n-process.ts";
import type { MessageKey } from "../../contracts/src/i18n.ts";
import { randomUUID } from "node:crypto";
import {
  A2A_CONTENT_TYPE,
  A2A_EXT,
  A2A_EXTENSIONS_HEADER,
  A2A_VERSION,
  A2A_VERSION_HEADER,
  TASK_STATES,
  type A2ATask,
  type TaskState,
} from "../../contracts/src/a2a.ts";
import { A2A_CLIENT_LIMITS } from "../../contracts/src/limits.ts";
import {
  OutboundError,
  outboundRequest,
  outboundUrl,
  type AddrKind,
  type OutboundPolicy,
  type TlsSeen,
} from "./net.ts";
import { BindingError, TLS_BINDING_PATH, TlsBindingVerifier } from "./binding.ts";
import { TLS_BINDING_LIMITS } from "../../contracts/src/limits.ts";
import type { PublicJwk } from "./identity.ts";

const CL = A2A_CLIENT_LIMITS;

export interface PeerOptions {
  /** The other Daisy's root (`addrs[].url` of its identity card). */
  root: string;
  kind: AddrKind;
  /** A fresh access token for every request (token.md §5: good once). */
  token: () => Promise<string>;
  policy?: OutboundPolicy;
  /** A certificate no CA vouches for (see net.ts). */
  tlsCheck?: (seen: TlsSeen) => true | string;
  /**
   * P5-02: the other Daisy's TLS binding claims (binding.ts) — required for
   * a `relay` address, used for no other. `onRefused` hears why a
   * connection was not used (the caller warns its owner).
   */
  binding?: { verifier: Pick<TlsBindingVerifier, "check">; onRefused?: (origin: string, e: BindingError) => void };
}

/**
 * P5-02: a binding verifier for one contact (its key from the address
 * book): the claim is fetched with no token — `GET <origin>/.well-known/
 * daisy-tls-binding`, any certificate on that connection (it carries
 * nothing of ours; the signature is the proof), size and time capped.
 */
export function bindingVerifierFor(key: PublicJwk, kind: AddrKind, policy?: OutboundPolicy): TlsBindingVerifier {
  return new TlsBindingVerifier({
    key,
    fetch: async (origin) => {
      let r;
      try {
        r = await outboundRequest({
          url: origin + TLS_BINDING_PATH,
          kind,
          method: "GET",
          headers: { accept: "application/jwt" },
          timeoutMs: TLS_BINDING_LIMITS.fetchTimeoutMs,
          maxBytes: TLS_BINDING_LIMITS.maxBytes,
          ...(policy ? { policy } : {}),
          tlsCheck: () => true,
        });
      } catch (e) {
        throw new BindingError("malformed", "a2a.peer.bindingFetch", { why: (e as Error).message });
      }
      if (r.status !== 200) throw new BindingError("malformed", "a2a.peer.bindingMissing", { status: r.status });
      return r.body.toString("utf8");
    },
  });
}

/**
 * What went wrong talking to the other side. `message` is ours (safe to
 * show; `key` / `params` say it in another language); `remoteMessage`
 * theirs (external).
 */
export class PeerError extends KeyedError {
  constructor(
    readonly kind:
      | "unreachable" // never got an answer (offline, DNS, connection, time-out): may be tried again
      | "refused" // not connected on purpose (address refused, TLS not trusted, redirect, too large): never retried
      | "busy" // 429 RESOURCE_EXHAUSTED / 503 UNAVAILABLE: try again after `retryAfterS`
      | "unauthenticated" // 401: they do not recognise us
      | "forbidden" // 403
      | "not_found" // 404: no such agent (or not for us)
      | "a2a" // an A2A error (reason in `reason`)
      | "protocol", // an answer we cannot read
    key: MessageKey,
    params: Record<string, string | number> = {},
    readonly more: {
      status?: number;
      reason?: string;
      remoteMessage?: string;
      /** The request may have reached them (resend with the same messageId). */
      maybeDelivered?: boolean;
      /** `busy`: the other side's Retry-After (seconds), when it said. */
      retryAfterS?: number;
      cause?: OutboundError;
    } = {},
  ) {
    super(key, params);
  }
}

export interface AgentEntry {
  agentId: string;
  name: string;
}

/** The parts of an agent card the client uses. */
export interface PeerCard {
  name: string;
  description: string;
  /** The interface chosen: JSON-RPC first (a2a-usage.md §15). */
  binding: "JSONRPC" | "HTTP+JSON";
  url: string;
  /** Extension URIs the card declares. */
  extensions: string[];
  /** The act extension's `params.act` (does it take 办 now), when said. */
  acceptsAct: boolean | null;
}

/** SendMessage's answer: a task, or (non-Daisy agents may) a direct message. */
export type SendResult = { task: A2ATask } | { message: { parts: unknown[] } };

/** Not now, later: per-caller limits (429) and a server closing or holding too many (503). */
const BUSY = new Set(["RESOURCE_EXHAUSTED", "UNAVAILABLE"]);

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");

function json(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new PeerError("protocol", "a2a.peer.notJson");
  }
}

/** An A2A error from either envelope: [reason, remote message]. */
function errorOf(v: any): { reason?: string; message?: string } {
  const e = v?.error;
  if (!e || typeof e !== "object") return {};
  const details: unknown[] = Array.isArray(e.details) ? e.details : Array.isArray(e.data) ? e.data : [];
  const info = details.find((d: any) => typeof d?.["@type"] === "string" && d["@type"].endsWith("ErrorInfo")) as any;
  return {
    ...(typeof info?.reason === "string" ? { reason: info.reason.slice(0, 80) } : {}),
    ...(typeof e.message === "string" ? { message: e.message.slice(0, 1000) } : {}),
  };
}

/** A task as the other side sent it: the fields we rely on are checked, strings capped. */
export function readTask(v: unknown): A2ATask {
  const t = v as any;
  if (!t || typeof t !== "object" || typeof t.id !== "string" || typeof t.contextId !== "string")
    throw new PeerError("protocol", "a2a.peer.taskShape");
  const state = t.status?.state;
  if (!(TASK_STATES as readonly string[]).includes(state)) throw new PeerError("protocol", "a2a.peer.taskState");
  if (t.id.length > CL.idMax || t.contextId.length > CL.idMax) throw new PeerError("protocol", "a2a.peer.idTooLong");
  return {
    id: t.id,
    contextId: t.contextId,
    status: {
      state: state as TaskState,
      timestamp: str(t.status.timestamp, 64),
      ...(t.status.message && typeof t.status.message === "object" ? { message: t.status.message } : {}),
    },
    ...(Array.isArray(t.artifacts) ? { artifacts: t.artifacts.slice(0, 64) } : {}),
    ...(t.metadata && typeof t.metadata === "object" ? { metadata: t.metadata } : {}),
  };
}

/** Text parts of a message / artifact, joined (data parts as JSON). */
export function partsText(parts: unknown, max: number = CL.answerMax): string {
  if (!Array.isArray(parts)) return "";
  const out: string[] = [];
  for (const p of parts.slice(0, 64) as any[]) {
    if (typeof p?.text === "string") out.push(p.text);
    else if (p && "data" in p && p.data !== undefined) {
      // A reason part ({data:{reason}}) is read separately.
      if (p.data && typeof p.data === "object" && Object.keys(p.data).length === 1 && "reason" in p.data) continue;
      out.push(JSON.stringify(p.data));
    }
  }
  const s = out.join("\n\n");
  return s.length > max ? s.slice(0, max) + pt("a2a.peer.truncated") : s;
}

/** The `{data:{reason}}` part of a status message (a2a-usage.md §9.2). */
export function reasonOf(parts: unknown): string | null {
  if (!Array.isArray(parts)) return null;
  for (const p of parts as any[]) if (typeof p?.data?.reason === "string") return p.data.reason.slice(0, 60);
  return null;
}

/** A completed task's answer: artifact `answer` (else every artifact's text) and the files' names. */
export function answerOf(t: A2ATask): { text: string; files: string[] } {
  const arts = (t.artifacts ?? []) as any[];
  const main = arts.find((a) => a?.artifactId === "answer");
  const text = main ? partsText(main.parts) : partsText(arts.flatMap((a) => (Array.isArray(a?.parts) ? a.parts : [])));
  const files: string[] = [];
  for (const a of arts)
    for (const p of Array.isArray(a?.parts) ? a.parts : [])
      if (typeof p?.raw === "string" || typeof p?.url === "string") files.push(str(p.filename, 120) || str(a.artifactId, 60) || "file");
  return { text, files: files.slice(0, 32) };
}

export class A2APeer {
  readonly origin: string;
  private root: string;

  constructor(private o: PeerOptions) {
    const u = outboundUrl(o.root, o.kind);
    this.origin = u.origin;
    this.root = u.origin + u.pathname.replace(/\/+$/, "");
  }

  private async request(
    url: string,
    method: "GET" | "POST",
    o: { body?: unknown; headers?: Record<string, string>; maxBytes: number; timeoutMs: number; contentType?: string },
  ): Promise<{ status: number; value: unknown; retryAfterS?: number }> {
    // Never anywhere but this Daisy (a card's interface URL is checked too).
    if (new URL(url).origin !== this.origin) throw new PeerError("protocol", "a2a.peer.foreignOrigin");
    // P5-02: a relay address only with the binding claim checked (fail closed).
    if (this.o.kind === "relay" && !this.o.binding)
      throw new PeerError("refused", "a2a.peer.relayNeedsBinding");
    const binding = this.o.binding;
    const token = await this.o.token();
    let r;
    try {
      r = await outboundRequest({
        url,
        kind: this.o.kind,
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: o.contentType ?? "application/json",
          ...(o.body !== undefined ? { "content-type": o.contentType ?? "application/json" } : {}),
          ...o.headers,
        },
        ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
        timeoutMs: o.timeoutMs,
        maxBytes: o.maxBytes,
        ...(this.o.policy ? { policy: this.o.policy } : {}),
        ...(this.o.tlsCheck ? { tlsCheck: this.o.tlsCheck } : {}),
        ...(binding && this.o.kind === "relay"
          ? {
              binding: async (seen: TlsSeen) => {
                try {
                  await binding.verifier.check(seen.origin, seen.spki);
                  return true as const;
                } catch (e) {
                  const be = e instanceof BindingError ? e : new BindingError("malformed", "a2a.net.bindingUnchecked");
                  binding.onRefused?.(seen.origin, be);
                  return be.message;
                }
              },
            }
          : {}),
      });
    } catch (e) {
      if (e instanceof OutboundError)
        throw new PeerError(["dns", "connect", "timeout"].includes(e.code) ? "unreachable" : "refused", e.key, e.params, {
          maybeDelivered: e.maybeDelivered,
          cause: e,
        });
      throw e;
    }
    const ra = Number(String(r.headers["retry-after"] ?? "").trim());
    const retryAfterS = Number.isFinite(ra) && ra >= 0 ? Math.min(ra, 24 * 3600) : undefined;
    const value = r.status === 413 && !r.body.length ? null : r.body.length ? json(r.body) : null;
    if (r.status === 401) throw new PeerError("unauthenticated", "a2a.peer.unauthenticated", {}, { status: 401 });
    if (r.status === 403) throw new PeerError("forbidden", "a2a.peer.forbidden", {}, { status: 403, ...errorOf(value) });
    if (r.status === 404 && !errorOf(value).reason?.startsWith("TASK"))
      throw new PeerError("not_found", "a2a.peer.notFound", {}, { status: 404 });
    if (r.status === 503 || r.status === 429 || BUSY.has(errorOf(value).reason ?? ""))
      throw new PeerError(
        "busy",
        r.status === 503 || errorOf(value).reason === "UNAVAILABLE"
          ? "a2a.peer.busy"
          : "a2a.peer.tooMany",
        {},
        {
          status: r.status,
          ...(errorOf(value).reason ? { reason: errorOf(value).reason } : {}),
          ...(errorOf(value).message ? { remoteMessage: errorOf(value).message } : {}),
          ...(retryAfterS !== undefined ? { retryAfterS } : {}),
        },
      );
    if (r.status === 413)
      throw new PeerError("a2a", "a2a.peer.payloadTooLarge", {}, { status: 413, reason: "PAYLOAD_TOO_LARGE" });
    return { status: r.status, value, ...(retryAfterS !== undefined ? { retryAfterS } : {}) };
  }

  private fail(status: number, value: unknown): never {
    const e = errorOf(value);
    throw new PeerError("a2a", e.reason ? "a2a.peer.remoteErrorReason" : "a2a.peer.remoteError", e.reason ? { reason: e.reason } : {}, {
      status,
      ...(e.reason ? { reason: e.reason } : {}),
      ...(e.message ? { remoteMessage: e.message } : {}),
    });
  }

  /** a2a-usage.md §2: the agents this caller may see there. */
  async directory(): Promise<AgentEntry[]> {
    const { status, value } = await this.request(`${this.root}/a2a`, "GET", {
      maxBytes: CL.cardMaxBytes,
      timeoutMs: CL.discoverTimeoutMs,
    });
    if (status !== 200) this.fail(status, value);
    const list = (value as any)?.agents;
    if (!Array.isArray(list)) throw new PeerError("protocol", "a2a.peer.directoryShape");
    return list
      .slice(0, CL.directoryMax)
      .filter((a: any) => typeof a?.agentId === "string" && a.agentId.length <= CL.idMax)
      .map((a: any) => ({ agentId: a.agentId, name: str(a.name, 120) || a.agentId }));
  }

  private agentBase(agentId: string) {
    return `${this.root}/a2a/${encodeURIComponent(agentId)}`;
  }

  /** The agent's card, and the interface to use. */
  async card(agentId: string): Promise<PeerCard> {
    const { status, value } = await this.request(`${this.agentBase(agentId)}/.well-known/agent-card.json`, "GET", {
      maxBytes: CL.cardMaxBytes,
      timeoutMs: CL.requestTimeoutMs,
    });
    if (status !== 200) this.fail(status, value);
    const c = value as any;
    const ifaces: any[] = Array.isArray(c?.supportedInterfaces) ? c.supportedInterfaces.slice(0, 16) : [];
    const ok = (b: string) =>
      ifaces.find((i) => {
        if (i?.protocolBinding !== b || typeof i.url !== "string") return false;
        if (i.protocolVersion !== undefined && !/^1\.0(\.\d+)?$/.test(String(i.protocolVersion))) return false;
        try {
          return new URL(i.url).origin === this.origin;
        } catch {
          return false;
        }
      });
    const pick = ok("JSONRPC") ?? ok("HTTP+JSON");
    if (!pick)
      throw new PeerError(
        "protocol",
        ifaces.length ? "a2a.peer.noUsableInterface" : "a2a.peer.noInterface",
      );
    const exts: any[] = Array.isArray(c?.capabilities?.extensions) ? c.capabilities.extensions.slice(0, 32) : [];
    const act = exts.find((e) => e?.uri === A2A_EXT.act);
    return {
      name: str(c?.name, 120),
      description: str(c?.description, 1000),
      binding: pick.protocolBinding,
      url: String(pick.url).replace(/\/+$/, ""),
      extensions: exts.map((e) => str(e?.uri, 300)).filter(Boolean),
      acceptsAct: typeof act?.params?.act === "boolean" ? act.params.act : null,
    };
  }

  /** One operation over the card's interface. */
  private async op(
    card: Pick<PeerCard, "binding" | "url">,
    method: "SendMessage" | "GetTask" | "CancelTask",
    params: Record<string, any>,
    headers: Record<string, string>,
    timeoutMs: number,
  ): Promise<unknown> {
    const h = { [A2A_VERSION_HEADER]: A2A_VERSION, ...headers };
    if (card.binding === "JSONRPC") {
      const id = randomUUID();
      const { status, value } = await this.request(card.url, "POST", {
        body: { jsonrpc: "2.0", id, method, params },
        headers: h,
        maxBytes: CL.taskMaxBytes,
        timeoutMs,
      });
      const v = value as any;
      if (v?.error) this.fail(status, v);
      if (status !== 200 || !v || typeof v !== "object" || !("result" in v)) throw new PeerError("protocol", "a2a.peer.rpcShape");
      return v.result;
    }
    const tid = encodeURIComponent(String(params.id ?? ""));
    const [path, verb, body] =
      method === "SendMessage"
        ? [`${card.url}/message:send`, "POST" as const, params]
        : method === "GetTask"
          ? [`${card.url}/tasks/${tid}${params.historyLength !== undefined ? `?historyLength=${Number(params.historyLength)}` : ""}`, "GET" as const, undefined]
          : [`${card.url}/tasks/${tid}:cancel`, "POST" as const, {}];
    const { status, value } = await this.request(path, verb, {
      ...(body !== undefined ? { body } : {}),
      headers: h,
      maxBytes: CL.taskMaxBytes,
      timeoutMs,
      contentType: A2A_CONTENT_TYPE,
    });
    if (status !== 200) this.fail(status, value);
    return value;
  }

  /**
   * SendMessage. `extensions`: the URIs to enable (A2A-Extensions);
   * `traceparent`: the same trace as the message's trace extension.
   */
  async send(
    card: Pick<PeerCard, "binding" | "url">,
    params: Record<string, any>,
    o: { extensions?: string[]; traceparent?: string } = {},
  ): Promise<SendResult> {
    const headers: Record<string, string> = {};
    if (o.extensions?.length) headers[A2A_EXTENSIONS_HEADER] = o.extensions.join(", ");
    if (o.traceparent) headers.traceparent = o.traceparent;
    const r = (await this.op(card, "SendMessage", params, headers, CL.requestTimeoutMs)) as any;
    if (r?.task) return { task: readTask(r.task) };
    if (r?.message && Array.isArray(r.message.parts)) return { message: { parts: r.message.parts } };
    // Some servers answer the task itself.
    if (r?.id && r?.status) return { task: readTask(r) };
    throw new PeerError("protocol", "a2a.peer.sendShape");
  }

  async getTask(card: Pick<PeerCard, "binding" | "url">, taskId: string): Promise<A2ATask> {
    return readTask(await this.op(card, "GetTask", { id: taskId, historyLength: 0 }, {}, CL.requestTimeoutMs));
  }

  async cancelTask(card: Pick<PeerCard, "binding" | "url">, taskId: string): Promise<A2ATask> {
    return readTask(await this.op(card, "CancelTask", { id: taskId }, {}, CL.requestTimeoutMs));
  }
}
