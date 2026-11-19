/** P1-06: the session routes of packages/daisy/src/app/sessions.ts. */
import { z } from "zod";
import { cmd, group, json, route } from "./route.ts";
import { CreateSessionSchema, type Session } from "../session.ts";
import { SessionSettingsSchema } from "../profile.ts";
import type { Event, ItemsPage, Snapshot } from "../items.ts";
import type { SessionPublic } from "./invoke.ts";

/** A conversation's page size of its visible view, clamped. */
const pageSize = z
  .union([z.string(), z.number()])
  .optional()
  .describe("api.field.sessions.pageSize");

export const sessions = group("session", {
  list: route({
    method: "GET",
    path: "/api/sessions",
    scope: "daisy:session:read",
    query: z.object({
      taskId: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("api.route.session.list.field.taskId"),
    }),
    output: json<Session[]>("Session[]"),
    cli: cmd("session list"),
  }),
  create: route({
    method: "POST",
    path: "/api/sessions",
    scope: "daisy:session:write",
    idempotent: true,
    body: CreateSessionSchema,
    // visibility / visibleTo: accepted, ignored until stage 4 (always private).
    bodyFull: CreateSessionSchema.omit({ visibility: true, visibleTo: true }),
    output: json<Session & { duplicate?: boolean }>("Session"),
    errors: ["agent_profile_node_mismatch", "node_not_found", "node_revoked", "read_only_unsupported", "request_id_conflict", "workspace_or_profile_unavailable"],
    cli: cmd("session create"),
  }),
  show: route({
    method: "GET",
    path: "/api/sessions/:id",
    scope: "daisy:session:read",
    aiSelf: "id",
    query: z.object({
      tail: z.coerce
        .number()
        .int()
        .min(0)
        .max(5000)
        .catch(0)
        .describe("api.route.session.show.field.tail"),
      since: z.coerce
        .number()
        .int()
        .min(0)
        .optional()
        .catch(undefined)
        .describe("api.route.session.show.field.since"),
      from: z
        .string()
        .min(1)
        .max(400)
        .optional()
        .catch(undefined)
        .describe("api.route.session.show.field.from"),
      view: z
        .enum(["conversation"])
        .optional()
        .catch(undefined)
        .describe("api.route.session.show.field.view"),
      messageLimit: pageSize,
    }),
    output: json<Snapshot>("Snapshot"),
    errors: ["not_session_owner", "session_not_found"],
    cli: cmd("session show"),
  }),
  items: route({
    method: "GET",
    path: "/api/sessions/:id/items",
    scope: "daisy:session:read",
    aiSelf: "id",
    query: z.object({
      before: z.string().min(1).max(400).describe("api.route.session.items.field.before"),
      view: z
        .enum(["conversation"])
        .optional()
        .catch(undefined)
        .describe("api.route.session.items.field.view"),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(1000)
        .catch(200)
        .describe("api.route.session.items.field.limit"),
    }),
    output: json<ItemsPage>("ItemsPage"),
    errors: ["item_gone", "not_session_owner", "session_not_found"],
    cli: cmd("session items"),
  }),
  update: route({
    method: "PATCH",
    path: "/api/sessions/:id",
    scope: "daisy:session:write",
    body: z.object({
      title: z.string().min(1).max(200).optional(),
      archived: z.boolean().optional(),
      /**
       * Related task ids to keep (fb3 F3 「取消关联」): entries not listed
       * are removed; ids not already related are ignored (no adding).
       */
      relatedTasks: z
        .array(z.string().min(1).max(200))
        .max(200)
        .optional()
        .describe("api.route.session.update.field.relatedTasks"),
      /** This conversation's model / effort; "" = the identity's. */
      settings: SessionSettingsSchema.optional().describe(
        "api.route.session.update.field.settings",
      ),
    }),
    output: json<Session>("Session"),
    errors: ["capability_unsupported", "not_session_owner", "session_not_found"],
    cli: cmd("session update"),
  }),
  events: route({
    method: "GET",
    path: "/api/sessions/:id/events",
    scope: "daisy:session:read",
    aiSelf: "id",
    query: z.object({
      after: z.coerce
        .number()
        .int()
        .nonnegative()
        .describe("api.route.session.events.field.after"),
    }),
    output: json<{ events: Event[]; hasMore: boolean }>(
      "{ events: Event[]; hasMore }",
    ),
    errors: ["not_session_owner", "session_not_found"],
    cli: cmd("session events"),
  }),
  cancel: route({
    method: "POST",
    path: "/api/sessions/:id/cancel",
    scope: "daisy:session:write",
    output: json<{ ok: true }>("{ ok: true }"),
    errors: ["not_session_owner", "session_not_found"],
    cli: cmd("session cancel"),
  }),
  delete: route({
    method: "DELETE",
    path: "/api/sessions/:id",
    scope: "daisy:session:write",
    output: json<{ ok: true; stopping: boolean; deleted: boolean }>(
      "{ ok, stopping, deleted }",
    ),
    errors: ["not_session_owner", "session_not_found"],
    cli: cmd("session delete"),
  }),
  // P4-06 (ADR-125): is it a public agent — reading is the owner's own
  // session (no PIN); making it public or private is `grant.publicSet`.
  publicShow: route({
    method: "GET",
    path: "/api/sessions/:id/public",
    scope: "daisy:session:read",
    output: json<SessionPublic>("SessionPublic"),
    errors: ["not_session_owner", "session_not_found"],
    cli: cmd("agent public show"),
  }),
  recoveries: route({
    method: "GET",
    path: "/api/sessions/:id/recoveries",
    scope: "daisy:session:read",
    aiSelf: "id",
    output: json<{ id: string; data: unknown; created: number }[]>(
      "{ id, data, created }[]",
    ),
    errors: ["not_session_owner", "session_not_found"],
    cli: cmd("session recovery list"),
  }),
  recoveryEvents: route({
    method: "GET",
    path: "/api/sessions/:id/recoveries/:jid/events",
    scope: "daisy:session:read",
    aiSelf: "id",
    query: z.object({
      after: z.coerce
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("api.route.session.recoveryEvents.field.after"),
    }),
    output: json<{ items: unknown[]; nextCursor: number | null }>(
      "{ items, nextCursor }",
    ),
    errors: ["not_session_owner", "recovery_not_found", "session_not_found"],
    cli: cmd("session recovery events"),
  }),
});
