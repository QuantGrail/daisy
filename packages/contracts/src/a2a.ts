/**
 * P4-04 (总纲 5.8, D-16, D-26, D-27, docs/contracts/a2a-usage.md, ADR-123):
 * the A2A 1.0 wire shapes Daisy speaks — what a caller sends, what the
 * server answers, the errors of both transports. The server
 * (packages/daisy/src/a2a/) validates with these; P4-08's client tools
 * and P4-09's standalone MCP build the same shapes.
 *
 * JSON follows the ProtoJSON of `a2a.proto` 1.0.1 (camelCase fields,
 * `TASK_STATE_*` / `ROLE_*` enum names, `Part` with exactly one of
 * text / raw / url / data).
 */
import { z } from "zod";
import { A2A_LIMITS } from "./limits.ts";
import type { Translate } from "./i18n.ts";
import { defaultTranslate } from "./i18n-default.ts";

/** The only A2A version served (a2a-usage.md §3: "主.次" compared). */
export const A2A_VERSION = "1.0";
export const A2A_VERSION_HEADER = "A2A-Version";
export const A2A_EXTENSIONS_HEADER = "A2A-Extensions";
/** HTTP+JSON answers (1.0.1 SHOULD); requests may also be application/json. */
export const A2A_CONTENT_TYPE = "application/a2a+json";

/** a2a-usage.md §8: both extensions are optional (`required: false`, 3.7 / A-1). */
export const A2A_EXT = {
  act: "https://quantgrail.github.io/a2a-ext/act/v1",
  trace: "https://quantgrail.github.io/a2a-ext/trace/v1",
} as const;

/** `ErrorInfo.domain`: the spec's errors, and this contract's own reasons. */
export const A2A_SPEC_DOMAIN = "a2a-protocol.org";
export const A2A_DAISY_DOMAIN = "quantgrail.github.io";

export const TASK_STATES = [
  "TASK_STATE_SUBMITTED",
  "TASK_STATE_WORKING",
  "TASK_STATE_INPUT_REQUIRED",
  "TASK_STATE_AUTH_REQUIRED",
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
] as const;
export type TaskState = (typeof TASK_STATES)[number];
/** Terminal: nothing more happens to the task (附录 A). */
export const TERMINAL_STATES: readonly TaskState[] = [
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
];
/** Interrupted: waiting on the caller or the owner — a blocking send returns here too (D-26). */
export const INTERRUPTED_STATES: readonly TaskState[] = ["TASK_STATE_INPUT_REQUIRED", "TASK_STATE_AUTH_REQUIRED"];
export const isTerminal = (s: string) => (TERMINAL_STATES as readonly string[]).includes(s);

/** a2a-usage.md §13 (D-28): the sentence a weak read-only agent's card description ends with. */
/** P6-23b: in `t`'s language (was the constant WEAK_READ_ONLY_NOTE). */
export const weakReadOnlyNote = (t: Translate = defaultTranslate()): string => t("server-contracts.a2a.weakReadOnly");

/**
 * a2a-usage.md §9.2: why a task was rejected or failed (`status.message`
 * carries `{ "data": { "reason": … } }`). `APPROVAL_CANCELED`: the card the
 * call waited on was voided (the caller left the range, a PIN reset) —
 * added by P4-04 (ADR-123).
 */
export const TASK_REASONS = [
  "OWNER_REJECTED",
  "APPROVAL_EXPIRED",
  "APPROVAL_CANCELED",
  "ACT_DISABLED",
  "ASK_NOT_SUPPORTED",
  "AGENT_PAUSED",
  "AGENT_UNAVAILABLE",
  "TRACE_DEPTH_EXCEEDED",
  "TRACE_CALLS_EXCEEDED",
  "QUOTA_EXCEEDED",
  "GRANT_REVOKED",
  /** P4-04 review L-2: waited on the caller past `A2A_LIMITS.inputIdleMs`. */
  "INPUT_EXPIRED",
  "EXECUTION_ERROR",
  "INTERRUPTED",
] as const;
export type TaskReason = (typeof TASK_REASONS)[number];

/**
 * a2a-usage.md §9.1: a request refused without a task — the JSON-RPC
 * `error.code`, the HTTP status, and the `ErrorInfo.reason` / domain.
 */
export const A2A_ERRORS = {
  UNAUTHENTICATED: { rpc: -31401, http: 401, domain: A2A_DAISY_DOMAIN },
  PERMISSION_DENIED: { rpc: -31403, http: 403, domain: A2A_DAISY_DOMAIN },
  /** The agent: unknown, private, or not open to this caller (T-3) — not JSON-RPC processing at all. */
  NOT_FOUND: { rpc: -31404, http: 404, domain: A2A_DAISY_DOMAIN },
  PARSE_ERROR: { rpc: -32700, http: 400, domain: A2A_DAISY_DOMAIN },
  INVALID_REQUEST: { rpc: -32600, http: 400, domain: A2A_DAISY_DOMAIN },
  METHOD_NOT_FOUND: { rpc: -32601, http: 404, domain: A2A_DAISY_DOMAIN },
  TASK_NOT_FOUND: { rpc: -32001, http: 404, domain: A2A_SPEC_DOMAIN },
  TASK_NOT_CANCELABLE: { rpc: -32002, http: 400, domain: A2A_SPEC_DOMAIN },
  PUSH_NOTIFICATION_NOT_SUPPORTED: { rpc: -32003, http: 400, domain: A2A_SPEC_DOMAIN },
  UNSUPPORTED_OPERATION: { rpc: -32004, http: 400, domain: A2A_SPEC_DOMAIN },
  CONTENT_TYPE_NOT_SUPPORTED: { rpc: -32005, http: 400, domain: A2A_SPEC_DOMAIN },
  EXTENDED_AGENT_CARD_NOT_CONFIGURED: { rpc: -32007, http: 400, domain: A2A_SPEC_DOMAIN },
  VERSION_NOT_SUPPORTED: { rpc: -32009, http: 400, domain: A2A_SPEC_DOMAIN },
  CONTEXT_MISMATCH: { rpc: -32602, http: 400, domain: A2A_DAISY_DOMAIN },
  CONTEXT_NOT_FOUND: { rpc: -32602, http: 400, domain: A2A_DAISY_DOMAIN },
  MESSAGE_ID_CONFLICT: { rpc: -32602, http: 400, domain: A2A_DAISY_DOMAIN },
  INVALID_ARGUMENT: { rpc: -32602, http: 400, domain: A2A_DAISY_DOMAIN },
  /** P4-04 review M-1: a per-caller limit (A2A_LIMITS) — nothing was stored; `Retry-After` says when. */
  RESOURCE_EXHAUSTED: { rpc: -31429, http: 429, domain: A2A_DAISY_DOMAIN },
  /** P4-04 review L-6: the request body is over `A2A_LIMITS.bodyMax`. */
  PAYLOAD_TOO_LARGE: { rpc: -31413, http: 413, domain: A2A_DAISY_DOMAIN },
  UNAVAILABLE: { rpc: -32603, http: 503, domain: A2A_DAISY_DOMAIN },
  INTERNAL: { rpc: -32603, http: 500, domain: A2A_DAISY_DOMAIN },
} as const;
export type A2AErrorReason = keyof typeof A2A_ERRORS;

/** google.rpc.Status `status` for an HTTP code (AIP-193). */
export const RPC_STATUS: Record<number, string> = {
  400: "INVALID_ARGUMENT",
  401: "UNAUTHENTICATED",
  403: "PERMISSION_DENIED",
  404: "NOT_FOUND",
  413: "INVALID_ARGUMENT",
  429: "RESOURCE_EXHAUSTED",
  500: "INTERNAL",
  503: "UNAVAILABLE",
};

/** JSON-RPC methods (1.0 names, not 0.3's `message/send`). */
export const A2A_METHODS = [
  "SendMessage",
  "SendStreamingMessage",
  "GetTask",
  "ListTasks",
  "CancelTask",
  "SubscribeToTask",
  "CreateTaskPushNotificationConfig",
  "GetTaskPushNotificationConfig",
  "ListTaskPushNotificationConfigs",
  "DeleteTaskPushNotificationConfig",
  "GetExtendedAgentCard",
] as const;

// ── what a caller sends ───────────────────────────────────────────────────
const L = A2A_LIMITS;
/** Empty strings are what ProtoJSON writers send for "not set". */
const optionalId = z
  .string()
  .max(L.idMax)
  .optional()
  .transform((v) => (v ? v : undefined));
const BASE64 = /^[A-Za-z0-9+/_-]*={0,2}$/;
/** Decoded size of a base64 / base64url string (no Buffer: contracts run in the browser too). */
export const base64Bytes = (s: string) => {
  const t = s.replace(/=+$/, "");
  return Math.floor((t.length * 3) / 4);
};

/**
 * How deep a JSON value nests (iterative: a hostile one cannot overflow
 * the stack); stops counting past `max`.
 */
export function jsonDepth(v: unknown, max = 1000): number {
  let deepest = 0;
  const stack: [unknown, number][] = [[v, 1]];
  while (stack.length) {
    const [x, d] = stack.pop()!;
    if (x === null || typeof x !== "object") continue;
    if (d > deepest) deepest = d;
    if (deepest > max) return deepest;
    for (const y of Array.isArray(x) ? x : Object.values(x as object)) stack.push([y, d + 1]);
  }
  return deepest;
}
/**
 * How deep a JSON text nests — `{` and `[` outside strings — read from the
 * text itself, before anything parses it; stops past `max`. A body too deep
 * is refused before any recursive step (JSON.stringify, a schema walk, …)
 * can see it: Linux's smaller stack overflowed where macOS's did not
 * (CI run 44103553516). Invalid JSON is the parser's to refuse.
 */
export function jsonTextDepth(text: string, max = 1000): number {
  let depth = 0;
  let deepest = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 92 /* \\ */) i++;
      else if (c === 34 /* " */) inString = false;
    } else if (c === 34) inString = true;
    else if (c === 123 /* { */ || c === 91 /* [ */) {
      if (++depth > deepest && (deepest = depth) > max) return deepest;
    } else if (c === 125 /* } */ || c === 93 /* ] */) depth--;
  }
  return deepest;
}
/** P4-04 review M-1 / L-5: `metadata` (a message's, a part's) — bounded size and depth. */
const metadataSchema = z.record(z.string(), z.unknown()).superRefine((m, ctx) => {
  if (jsonDepth(m, L.jsonDepthMax) > L.jsonDepthMax)
    return void ctx.addIssue({ code: "custom", message: defaultTranslate()("server-contracts.a2a.metadataDepth", { max: L.jsonDepthMax }) });
  if (JSON.stringify(m).length > L.metadataMax)
    ctx.addIssue({ code: "custom", message: defaultTranslate()("server-contracts.a2a.metadataSize", { max: L.metadataMax }) });
});

export const A2APartSchema = z
  .object({
    text: z.string().max(L.textMax).optional(),
    raw: z
      .string()
      .max(Math.ceil((L.fileMax * 4) / 3) + 4)
      .regex(BASE64, { error: () => defaultTranslate()("server-contracts.a2a.rawBase64") })
      .optional(),
    url: z.string().optional(),
    data: z.unknown().optional(),
    filename: z.string().max(L.filenameMax).optional(),
    mediaType: z.string().max(L.mediaTypeMax).optional(),
    metadata: metadataSchema.optional(),
  })
  .superRefine((p, ctx) => {
    const n = [p.text, p.raw, p.url, p.data].filter((x) => x !== undefined).length;
    if (n !== 1) ctx.addIssue({ code: "custom", message: defaultTranslate()("server-contracts.a2a.onePart") });
    if (p.url !== undefined)
      ctx.addIssue({
        code: "custom",
        path: ["url"],
        message: defaultTranslate()("server-contracts.a2a.noUrl"),
      });
    if (p.data !== undefined && jsonDepth(p.data, L.jsonDepthMax) > L.jsonDepthMax)
      ctx.addIssue({ code: "custom", path: ["data"], message: defaultTranslate()("server-contracts.a2a.dataDepth", { max: L.jsonDepthMax }) });
    else if (p.data !== undefined && JSON.stringify(p.data ?? null).length > L.textMax)
      ctx.addIssue({ code: "custom", path: ["data"], message: defaultTranslate()("server-contracts.a2a.dataSize", { max: L.textMax }) });
    if (p.raw !== undefined && base64Bytes(p.raw) > L.fileMax)
      ctx.addIssue({ code: "custom", path: ["raw"], message: defaultTranslate()("server-contracts.a2a.fileSize", { max: L.fileMax }) });
  });
export type A2APart = z.output<typeof A2APartSchema>;

export const A2AMessageSchema = z
  .object({
    messageId: z.string().min(L.messageIdMin).max(L.messageIdMax),
    role: z.literal("ROLE_USER"),
    parts: z.array(A2APartSchema).min(1).max(L.partsMax),
    contextId: optionalId,
    taskId: optionalId,
    referenceTaskIds: z.array(z.string().max(L.idMax)).max(L.referencesMax).optional(),
    metadata: metadataSchema.optional(),
    extensions: z.array(z.string().max(2048)).max(16).optional(),
  })
  .superRefine((m, ctx) => {
    const files = m.parts.filter((p) => p.raw !== undefined).length;
    if (files > L.filesMax)
      ctx.addIssue({ code: "custom", path: ["parts"], message: defaultTranslate()("server-contracts.a2a.filesMax", { max: L.filesMax }) });
  });
export type A2AMessageIn = z.output<typeof A2AMessageSchema>;

export const SendConfigurationSchema = z.object({
  acceptedOutputModes: z.array(z.string().max(200)).max(32).optional(),
  historyLength: z.number().int().min(0).optional(),
  returnImmediately: z.boolean().optional(),
  taskPushNotificationConfig: z.unknown().optional(),
});
export const SendMessageParamsSchema = z.object({
  tenant: z.string().optional(),
  message: A2AMessageSchema,
  configuration: SendConfigurationSchema.optional(),
  metadata: metadataSchema.optional(),
});
export type SendMessageParams = z.output<typeof SendMessageParamsSchema>;

/** GetTask / CancelTask (JSON-RPC params; HTTP+JSON takes the id from the path). */
export const TaskIdParamsSchema = z.object({
  tenant: z.string().optional(),
  id: z.string().min(1).max(L.idMax),
  historyLength: z.coerce.number().int().min(0).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const boolish = z.union([z.boolean(), z.enum(["true", "false"]).transform((v) => v === "true")]);
export const ListTasksParamsSchema = z.object({
  tenant: z.string().optional(),
  contextId: optionalId,
  status: z
    .union([z.enum(TASK_STATES), z.literal("TASK_STATE_UNSPECIFIED"), z.literal("")])
    .optional()
    .transform((v) => (v && v !== "TASK_STATE_UNSPECIFIED" ? v : undefined)),
  pageSize: z.coerce.number().int().min(1).max(L.pageMax).optional(),
  pageToken: z.string().max(400).optional(),
  historyLength: z.coerce.number().int().min(0).optional(),
  statusTimestampAfter: z.string().datetime({ offset: true }).optional(),
  includeArtifacts: boolish.optional(),
});
export type ListTasksParams = z.output<typeof ListTasksParamsSchema>;

// ── what the server answers ───────────────────────────────────────────────
export interface A2AMessageOut {
  messageId: string;
  contextId: string;
  taskId: string;
  role: "ROLE_USER" | "ROLE_AGENT";
  parts: A2APart[];
  metadata?: Record<string, unknown>;
  extensions?: string[];
  referenceTaskIds?: string[];
}
export interface A2AArtifact {
  artifactId: string;
  name?: string;
  parts: A2APart[];
}
export interface A2ATask {
  id: string;
  contextId: string;
  status: { state: TaskState; timestamp: string; message?: A2AMessageOut };
  artifacts?: A2AArtifact[];
  history?: A2AMessageOut[];
  metadata?: Record<string, unknown>;
}
export interface ListTasksResult {
  tasks: A2ATask[];
  nextPageToken: string;
  pageSize: number;
  totalSize: number;
}
/** a2a-usage.md §2: Daisy's agent directory (not part of A2A). */
export interface A2ADirectory {
  agents: { agentId: string; name: string; card: string }[];
}
