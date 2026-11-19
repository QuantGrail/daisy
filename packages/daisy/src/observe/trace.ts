/**
 * P1-11 (原则 7, docs/contracts/trace.md): the trace id — one per user
 * action, carried by everything that action causes (the audit rows, the
 * log lines, the turn it starts and that turn's tool actions).
 *
 * Format: W3C Trace Context `traceparent` (trace.md §2):
 *   00-<trace-id: 32 lower hex, not all 0>-<parent-id: 16 lower hex, not all 0>-<flags: 2 hex>
 * The trace id is the 链路号; the parent id is one hop's number (only for
 * matching log lines). A malformed `traceparent` counts as none (W3C): a
 * new trace starts and a warning is logged (trace.md §2).
 *
 * Where a request or a Runner call is being handled, `currentTrace()`
 * answers who is acting, through which face and channel, on which route
 * (AsyncLocalStorage, set by observe/request-audit.ts and
 * observe/runner-trace.ts). Stage 1 is this Daisy's side only; carrying it
 * to another Daisy (A2A metadata) is stage 4 (P4-08).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

/** Who acts (5.11's three identities, plus nobody and Daisy itself). */
export type ActorKind = "owner" | "cli" | "ai" | "visitor" | "anonymous" | "system";
/**
 * Which way it came in: one of the two faces (ADR-101), or `internal` —
 * inside this process (the harness's tools, timers, the Runner's reports).
 */
export type Entry = "local" | "external" | "internal";
/**
 * 5.11's channels, plus `issuer` (P2-01: the external issuer's token),
 * `system` (Daisy itself) and `none` (unidentified).
 */
export type AuditChannel = "web" | "device" | "cli" | "issuer" | "a2a" | "ai" | "system" | "none";

export interface TraceContext {
  /** The 链路号: 32 lower-case hex digits. */
  traceId: string;
  /** This hop (16 hex); a new one per request / call. */
  spanId: string;
  /** trace.md §3: 0 for the owner's own actions and timers (stage 1). */
  depth: number;
  actor: ActorKind;
  /** The AI's session and turn (actor `ai`), or the turn a system call acts for. */
  sessionId?: string;
  jobId?: string;
  face: Entry;
  channel: AuditChannel;
  /** Route id (`session.cancel`) or tool (`tool.wakeup`). */
  route?: string;
}

const TRACE_RE = /^[0-9a-f]{32}$/;
const ZERO_TRACE = "0".repeat(32);
const ZERO_SPAN = "0".repeat(16);

function hex(bytes: number, zero: string): string {
  for (;;) {
    const v = randomBytes(bytes).toString("hex");
    if (v !== zero) return v;
  }
}
export const newTraceId = () => hex(16, ZERO_TRACE);
export const newSpanId = () => hex(8, ZERO_SPAN);
export const isTraceId = (v: unknown): v is string =>
  typeof v === "string" && TRACE_RE.test(v) && v !== ZERO_TRACE;

export interface Traceparent {
  traceId: string;
  parentId: string;
  flags: string;
}
/**
 * A `traceparent` header (W3C Trace Context §3.2): null when absent or
 * malformed. Version `00` must be exactly four fields; a later version
 * may carry more after the flags (read the first four); `ff` is invalid.
 */
export function parseTraceparent(h: unknown): Traceparent | null {
  if (typeof h !== "string") return null;
  const v = h.trim();
  const m =
    /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/.exec(v);
  if (!m) return null;
  const [, version, traceId, parentId, flags, rest] = m;
  if (version === "ff") return null;
  if (version === "00" && rest !== undefined) return null;
  if (traceId === ZERO_TRACE || parentId === ZERO_SPAN) return null;
  return { traceId: traceId!, parentId: parentId!, flags: flags! };
}
export const formatTraceparent = (traceId: string, spanId: string) =>
  `00-${traceId}-${spanId}-00`;

const store = new AsyncLocalStorage<TraceContext>();
/** What is being handled now (undefined: outside any request or call). */
export const currentTrace = (): TraceContext | undefined => store.getStore();
/** Run `fn` as part of `ctx` (everything it starts, awaits included). */
export const runInTrace = <T>(ctx: TraceContext, fn: () => T): T =>
  store.run(ctx, fn);
/** Daisy acting on its own (a timer, a sweep, a Runner report): a new trace. */
export const systemTrace = (more: Partial<TraceContext> = {}): TraceContext => ({
  traceId: newTraceId(),
  spanId: newSpanId(),
  depth: 0,
  actor: "system",
  face: "internal",
  channel: "system",
  ...more,
});
/**
 * The trace a new turn records (jobs.trace): the action's that queued it,
 * or — a timer, a background result, an outside wake (trace.md §3) — a new one.
 */
export const traceForNewTurn = (): string =>
  currentTrace()?.traceId ?? newTraceId();
