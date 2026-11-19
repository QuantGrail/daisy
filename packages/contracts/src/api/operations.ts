/**
 * P1-06: the routes of packages/daisy/src/sessions/commands.ts — native operations
 * (catalog, fork, rewind, compact…), 立即追加, and the queue.
 */
import { z } from "zod";
import { cmd, group, json, route } from "./route.ts";
import { MessageContextSchema } from "../message.ts";
import type {
  QueueJumpResult,
  QueueMergeJumpResult,
  QueueMergeSteerResult,
  QueueRemoveResult,
} from "../queue.ts";

/** The native operations a session can run (POST …/operations `name`). */
export const OPERATION_NAMES = [
  "catalog",
  "models",
  "skills",
  "mcp",
  "plugins",
  "config.read",
  "config.write",
  "mcp.add",
  "mcp.remove",
  "plugin.install",
  "plugin.uninstall",
  "skill.write",
  "fork",
  "rewind",
  "compact",
  "review",
  "terminal",
] as const;

/**
 * P1-03 (ADR-110): the operations that change the harness's own
 * configuration — its config file, MCP servers, plugins, skills. They are
 * not "a session operation" but setting up the AI (5.11 「系统」:
 * `daisy:manage`), so they have their own route
 * (`POST …/operations/harness`); the session route refuses them.
 */
export const HARNESS_CONFIG_OPERATIONS = [
  "config.write",
  "mcp.add",
  "mcp.remove",
  "plugin.install",
  "plugin.uninstall",
  "skill.write",
] as const satisfies readonly (typeof OPERATION_NAMES)[number][];
/**
 * P1-03 review M-1: opening a terminal is its own route too
 * (`POST …/operations/terminal`), so the outside face's terminal switch
 * (`external: "terminal"`) covers it.
 */
export const TERMINAL_OPERATION = "terminal" as const;
export const SESSION_OPERATION_NAMES = OPERATION_NAMES.filter(
  (n) =>
    !(HARNESS_CONFIG_OPERATIONS as readonly string[]).includes(n) &&
    n !== TERMINAL_OPERATION,
) as Exclude<
  (typeof OPERATION_NAMES)[number],
  (typeof HARNESS_CONFIG_OPERATIONS)[number] | typeof TERMINAL_OPERATION
>[];

/** 「回退」's `args.count` (parsed when the operation is a rewind). */
export const RewindCountSchema = z.coerce.number().int().min(1).max(10000);

/** the queued messages picked (`ids`, or `all`). */
const QueueSelectionSchema = z.object({
  ids: z
    .array(z.string().max(100))
    .max(20)
    .optional()
    .describe("api.field.operations.ids"),
  all: z.boolean().optional().describe("api.field.operations.all"),
});

export const operations = group("session", {
  operation: route({
    method: "POST",
    path: "/api/sessions/:id/operations",
    scope: "daisy:session:write",
    idempotent: true,
    body: z.object({
      requestId: z.string().min(8).max(100),
      name: z
        .enum(SESSION_OPERATION_NAMES as [string, ...string[]])
        .describe("api.route.session.operation.field.name"),
      args: z
        .record(z.string(), z.unknown())
        .default({})
        .describe("api.route.session.operation.field.args"),
    }),
    output: json<{ id: string; sessionId: string }>("{ id, sessionId }"),
    errors: ["resident_paused", "capability_unsupported", "item_not_in_conversation", "login_in_progress", "no_native_session", "node_revoked", "not_session_owner", "operation_too_large", "profile_gone", "rewind_too_far", "session_busy", "session_not_found"],
    cli: cmd("session operation run", { args: ["id", "name"] }),
  }),
  harnessConfig: route({
    method: "POST",
    path: "/api/sessions/:id/operations/harness",
    scope: "daisy:manage",
    // Review M-1: `mcp.add` writes a command line, `config.write` can write
    // hooks — both run commands later, so the outside face's command switch
    // covers them.
    external: "shell",
    idempotent: true,
    body: z.object({
      requestId: z.string().min(8).max(100),
      name: z.enum(HARNESS_CONFIG_OPERATIONS).describe("api.route.session.harnessConfig.field.name"),
      args: z
        .record(z.string(), z.unknown())
        .default({})
        .describe("api.route.session.harnessConfig.field.args"),
    }),
    output: json<{ id: string; sessionId: string }>("{ id, sessionId }"),
    errors: ["resident_paused", "login_in_progress", "node_revoked", "not_session_owner", "operation_too_large", "profile_gone", "session_busy", "session_not_found"],
    cli: cmd("session operation harness", { args: ["id", "name"] }),
  }),
  terminalOpen: route({
    method: "POST",
    path: "/api/sessions/:id/operations/terminal",
    scope: "daisy:session:write",
    external: "terminal",
    idempotent: true,
    body: z.object({
      requestId: z.string().min(8).max(100),
      name: z.literal(TERMINAL_OPERATION).describe("api.route.session.terminalOpen.field.name"),
      args: z
        .record(z.string(), z.unknown())
        .default({})
        .describe("api.route.session.terminalOpen.field.args"),
    }),
    output: json<{ id: string; sessionId: string }>("{ id, sessionId }"),
    errors: ["resident_paused", "capability_unsupported", "login_in_progress", "node_revoked", "not_session_owner", "operation_too_large", "profile_gone", "session_busy", "session_not_found"],
    cli: cmd("session terminal open", { args: ["id"] }),
  }),
  operationStatus: route({
    method: "GET",
    path: "/api/sessions/:id/operations/:jid",
    scope: "daisy:session:read",
    output: json<{ status: string; result: unknown }>("{ status, result }"),
    errors: ["not_session_owner", "operation_not_found", "session_not_found"],
    cli: cmd("session operation status"),
  }),
  steer: route({
    method: "POST",
    path: "/api/sessions/:id/steer",
    scope: "daisy:session:write",
    idempotent: true,
    body: z.object({
      requestId: z.string().min(8).max(100),
      text: z.string().min(1).max(100000),
      /** Host page context (fb3 F1), prepended when the runner hands it over. */
      context: MessageContextSchema.optional().describe("api.route.session.steer.field.context"),
    }),
    output: json<{
      id: string;
      status: string;
      queued?: boolean;
      reason?: string;
    }>("{ id, status, queued?, reason? }"),
    errors: ["capability_unsupported", "no_active_turn", "node_revoked", "not_session_owner", "profile_gone", "session_not_found"],
    cli: cmd("session steer", { args: ["id", "text"] }),
  }),
  queue: route({
    method: "GET",
    path: "/api/sessions/:id/queue",
    scope: "daisy:session:read",
    aiSelf: "id",
    output: json<{ id: string; text: string; status: string }[]>(
      "{ id, text, status, jump?, from?, jumpBlocked?, … }[]",
    ),
    errors: ["not_session_owner", "session_not_found"],
    cli: cmd("session queue list"),
  }),
  queueResume: route({
    method: "POST",
    path: "/api/sessions/:id/queue/resume",
    scope: "daisy:session:write",
    output: json<{ id: string }>("{ id }"),
    errors: ["resident_paused", "node_revoked", "not_session_owner", "profile_gone", "queue_empty", "session_not_found", "session_running"],
    cli: cmd("session queue resume"),
  }),
  queueJump: route({
    method: "POST",
    path: "/api/sessions/:id/queue/:jid/jump",
    scope: "daisy:session:write",
    output: json<QueueJumpResult>("QueueJumpResult"),
    errors: ["resident_paused", "native_operation_running", "node_revoked", "not_session_owner", "profile_gone", "queued_not_found", "session_not_found"],
    cli: cmd("session queue jump"),
  }),
  queueMergeJump: route({
    method: "POST",
    path: "/api/sessions/:id/queue/merge-jump",
    scope: "daisy:session:write",
    body: QueueSelectionSchema,
    output: json<QueueMergeJumpResult>("QueueMergeJumpResult"),
    errors: ["resident_paused", "native_operation_running", "node_revoked", "not_session_owner", "profile_gone", "queue_empty", "queue_selection_empty", "queued_not_found", "session_not_found"],
    cli: cmd("session queue merge-jump"),
  }),
  queueMergeSteer: route({
    method: "POST",
    path: "/api/sessions/:id/queue/merge-steer",
    scope: "daisy:session:write",
    body: QueueSelectionSchema,
    output: json<QueueMergeSteerResult>("QueueMergeSteerResult"),
    errors: ["resident_paused", "capability_unsupported", "context_differs", "merge_too_long", "no_active_turn", "node_revoked", "not_appendable", "not_session_owner", "profile_gone", "queue_empty", "queue_selection_empty", "queued_not_found", "session_not_found"],
    cli: cmd("session queue merge-steer"),
  }),
  queueRemove: route({
    method: "DELETE",
    path: "/api/sessions/:id/queue/:jid",
    scope: "daisy:session:write",
    output: json<{ ok: true; withdrawing?: boolean }>(
      "{ ok: true, withdrawing? }",
    ),
    errors: ["not_session_owner", "queued_not_found", "session_not_found"],
    cli: cmd("session queue remove"),
  }),
  queueRemoveMany: route({
    method: "POST",
    path: "/api/sessions/:id/queue/remove",
    scope: "daisy:session:write",
    body: z.object({
      ids: z
        .array(z.string().max(100))
        .max(100)
        .optional()
        .describe("api.route.session.queueRemoveMany.field.ids"),
      all: z.boolean().optional().describe("api.route.session.queueRemoveMany.field.all"),
    }),
    output: json<QueueRemoveResult>("QueueRemoveResult"),
    errors: ["not_session_owner", "queue_empty", "queue_selection_empty", "session_not_found"],
    cli: cmd("session queue remove-many"),
  }),
});
