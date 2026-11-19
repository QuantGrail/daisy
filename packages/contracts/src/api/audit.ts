/**
 * P1-11 (5.11 「查看日志和审计」: 主人本人 ✓ 命令行 ✓ AI —; S-4): reading
 * the audit and the recent log lines. packages/daisy/src/observe/routes.ts.
 */
import { z } from "zod";
import { cmd, group, json, route } from "./route.ts";

/**
 * Who acted (5.11's three identities, plus nobody and Daisy itself; P2-01:
 * `visitor` — a valid token of the external issuer that is not the
 * owner's, refused on every local route).
 */
export type AuditActor = "owner" | "cli" | "ai" | "visitor" | "anonymous" | "system";
/**
 * P2-01: `issuer` — the external issuer's token (the owner's, or a
 * visitor's). P4-01: `a2a` — a token a contact signed (a visitor).
 */
export const AUDIT_CHANNELS = ["web", "device", "cli", "issuer", "a2a", "ai", "system", "none"] as const;
export type AuditChannel = (typeof AUDIT_CHANNELS)[number];
export const AUDIT_OUTCOMES = ["ok", "denied", "error"] as const;

/** One audit row (S-4). */
export interface AuditRecord {
  id: string;
  /** Milliseconds since the epoch. */
  at: number;
  /** `api.<route id>` for a call of the local API (target: JSON {face, channel, status}); otherwise what happened (`session.create`, `access.denied`, `tool.wakeup`, `pin.grant` …). */
  action: string;
  /** Who: `owner` (主人本人: web page, paired device, the external issuer's token for the owner), `cli` (命令行), `ai` (an AI's working credential or its harness's tools), `visitor` (another's token from the external issuer), `anonymous` (no valid credential), `system` (Daisy itself: timers, its Runner). */
  actor: AuditActor;
  /** As recorded (`owner`, `cli`, `web`, `ai:<session>`, `anonymous`, `system`). */
  who: string;
  /** For `ai`: its session and turn; for `system`, the turn it acted for, if any. */
  sessionId: string | null;
  turnId: string | null;
  /** Which way it came in: the local face, the outside face, or inside this process (`internal`: the harness's tools, timers). */
  face: "local" | "external" | "internal";
  channel: AuditChannel;
  /** The route id (`session.cancel`), or `tool.<name>` for a harness tool. */
  route: string | null;
  /** What it was done to (ids), never a credential. */
  object: string | null;
  /** The row's own detail as recorded (for `access.denied`: JSON with face, channel, target, why). */
  target: string;
  outcome: "ok" | "denied" | "error";
  /** Refusal or error code (`pin_required`, `not_found` …), or `http_<status>`. */
  reason: string | null;
  status: number | null;
  /** The 链路号: 32 lower-case hex digits (trace.md). */
  trace: string | null;
  depth: number;
}

export interface AuditPage {
  records: AuditRecord[];
  /** Pass as `before` for the next (older) page; null: no more. */
  next: string | null;
}

export interface LogLineOut {
  seq: number;
  at: number;
  level: "info" | "warn" | "error";
  /** Already redacted (S-1). */
  text: string;
  trace?: string;
}

const ms = (key: string) =>
  z.coerce.number().int().nonnegative().optional().describe(key);

export const AuditQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(500)
      .default(100)
      .describe("api.field.audit.limit"),
    before: z
      .string()
      .regex(/^\d{1,16}:[\w-]{1,64}$/)
      .optional()
      .describe("api.field.audit.before"),
    since: ms("api.field.audit.since"),
    until: ms("api.field.audit.until"),
    channel: z.enum(AUDIT_CHANNELS).optional().describe("api.field.audit.channel"),
    route: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe("api.field.audit.route"),
    action: z.string().min(1).max(100).optional().describe("api.field.audit.action"),
    actor: z
      .enum(["owner", "cli", "ai", "visitor", "anonymous", "system"])
      .optional()
      .describe("api.field.audit.actor"),
    outcome: z.enum(AUDIT_OUTCOMES).optional().describe("api.field.audit.outcome"),
    session: z.string().min(1).max(200).optional().describe("api.field.audit.session"),
    trace: z
      .string()
      .regex(/^[0-9a-f]{32}$/)
      .optional()
      .describe("api.field.audit.trace"),
  })
  .strict();

export const LogQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(1000).default(200).describe("api.field.audit.limit2"),
    level: z.enum(["info", "warn", "error"]).optional().describe("api.field.audit.level"),
    trace: z
      .string()
      .regex(/^[0-9a-f]{32}$/)
      .optional()
      .describe("api.field.audit.trace"),
    after: z.coerce.number().int().nonnegative().optional().describe("api.field.audit.after"),
  })
  .strict();

export const audit = group("system", {
  auditList: route({
    method: "GET",
    path: "/api/audit",
    scope: "daisy:manage",
    audit: true,
    query: AuditQuerySchema,
    output: json<AuditPage>("AuditPage"),
    cli: cmd("audit list"),
  }),
  logs: route({
    method: "GET",
    path: "/api/logs",
    scope: "daisy:manage",
    audit: true,
    query: LogQuerySchema,
    output: json<{ lines: LogLineOut[] }>("{ lines: LogLine[] }"),
    cli: cmd("audit logs"),
  }),
});
