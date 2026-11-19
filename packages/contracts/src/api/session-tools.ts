/**
 * P1-06: the routes of packages/daisy/src/sessions/live.ts, background-tasks.ts,
 * scheduler.ts, shell.ts, terminal.ts.
 */
import { z } from "zod";
import { cmd, group, json, route } from "./route.ts";
import type { LiveActivity } from "../live.ts";
import {
  ScheduleCreateSchema,
  ScheduleUpdateSchema,
  type DaisySchedule,
  type ServerTimeZone,
} from "../scheduler.ts";
import { ShellRunSchema, type TerminalResult } from "../message.ts";

export const sessionTools = group("session", {
  activity: route({
    method: "GET",
    path: "/api/sessions/:id/live/activity",
    scope: "daisy:session:read",
    aiSelf: "id",
    output: json<{ at: number | null; items: LiveActivity[] }>(
      "{ at, items: LiveActivity[] }",
    ),
    errors: ["not_session_owner", "session_not_found"],
    cli: cmd("session activity"),
  }),
  offline: route({
    method: "POST",
    path: "/api/sessions/:id/offline",
    scope: "daisy:session:write",
    output: json<{ ok: true; stopping: boolean }>("{ ok, stopping }"),
    errors: ["not_session_owner", "session_not_found"],
    cli: cmd("session offline"),
  }),
  backgroundStop: route({
    method: "POST",
    path: "/api/sessions/:id/background/:tid/stop",
    scope: "daisy:session:write",
    output: json<{
      ok: true;
      stopped?: boolean;
      stopping?: boolean;
      source: "scheduler" | "agent";
    }>("{ ok, stopped | stopping, source }"),
    errors: ["not_stoppable", "offline", "background_owner_only", "background_task_not_found", "not_session_owner", "session_not_found"],
    cli: cmd("session background stop"),
  }),
  scheduleList: route({
    method: "GET",
    path: "/api/sessions/:id/schedules",
    scope: "daisy:session:read",
    aiSelf: "id",
    output: json<{
      schedules: DaisySchedule[];
      turnsToday: number;
      timeZone: ServerTimeZone;
    }>("{ schedules: DaisySchedule[], turnsToday, timeZone }"),
    errors: ["not_session_owner", "session_not_found"],
    cli: cmd("session schedule list"),
  }),
  scheduleAdd: route({
    method: "POST",
    path: "/api/sessions/:id/schedules",
    scope: "daisy:session:write",
    body: z
      .object({
        kind: z.enum(["wakeup", "cron"]).describe("api.route.session.scheduleAdd.field.kind"),
      })
      .passthrough(),
    // What create() then checks: the owner's two kinds of ScheduleCreate.
    bodyFull: z.discriminatedUnion("kind", [
      ScheduleCreateSchema.options[0],
      ScheduleCreateSchema.options[1],
    ]),
    output: json<{ schedule: DaisySchedule }>("{ schedule: DaisySchedule }"),
    errors: ["cron_invalid", "not_session_owner", "session_not_found"],
    cli: cmd("session schedule add"),
  }),
  scheduleUpdate: route({
    method: "PATCH",
    path: "/api/sessions/:id/schedules/:scid",
    scope: "daisy:session:write",
    body: ScheduleUpdateSchema,
    output: json<{ schedule: DaisySchedule }>("{ schedule: DaisySchedule }"),
    errors: ["cron_invalid", "not_session_owner", "session_not_found"],
    cli: cmd("session schedule update"),
  }),
  scheduleCancel: route({
    method: "POST",
    path: "/api/sessions/:id/schedules/:scid/cancel",
    scope: "daisy:session:write",
    output: json<{ schedule: DaisySchedule }>("{ schedule: DaisySchedule }"),
    errors: ["not_session_owner", "session_not_found"],
    cli: cmd("session schedule cancel"),
  }),
  shellRun: route({
    method: "POST",
    path: "/api/sessions/:id/shell",
    scope: "daisy:session:write",
    external: "shell",
    body: ShellRunSchema,
    output: json<{ id: string; status: string }>("{ id, status }"),
    errors: ["node_offline", "node_revoked", "not_session_owner", "session_not_found", "too_many_requests", "workspace_not_found"],
    cli: cmd("session shell run", { args: ["id", "command"] }),
  }),
  shellStatus: route({
    method: "GET",
    path: "/api/shell/:id",
    scope: "daisy:session:read",
    external: "shell",
    output: json<TerminalResult & { status: string }>(
      "TerminalResult & { status }",
    ),
    errors: ["shell_not_found"],
    cli: cmd("session shell status"),
  }),
  terminalList: route({
    method: "GET",
    path: "/api/sessions/:id/terminal",
    scope: "daisy:session:read",
    external: "terminal",
    output: json<{ job: { id: string; status: string } | null }>(
      "{ job: { id, status } | null }",
    ),
    errors: ["not_session_owner", "session_not_found"],
    cli: cmd("session terminal show"),
  }),
  terminalOutput: route({
    method: "GET",
    path: "/api/sessions/:id/terminal/:jid/output",
    scope: "daisy:session:read",
    external: "terminal",
    query: z.object({
      after: z.coerce
        .number()
        .int()
        .nonnegative()
        .describe("api.route.session.terminalOutput.field.after"),
    }),
    output: json<{
      chunks: { seq: number; data: string }[];
      status: string;
      truncated: boolean;
    }>("{ chunks, status, truncated }"),
    errors: ["not_session_owner", "not_terminal", "session_not_found", "terminal_not_found"],
    cli: cmd("session terminal output"),
  }),
  terminalInput: route({
    method: "POST",
    path: "/api/sessions/:id/terminal/:jid/input",
    audit: false,
    scope: "daisy:session:write",
    external: "terminal",
    idempotent: "id",
    body: z.object({
      id: z.string().min(8).max(100).describe("api.route.session.terminalInput.field.id"),
      text: z.string().max(16000).optional().describe("api.route.session.terminalInput.field.text"),
      cols: z.number().int().min(20).max(500).optional().describe("api.route.session.terminalInput.field.cols"),
      rows: z.number().int().min(5).max(150).optional().describe("api.route.session.terminalInput.field.rows"),
    }),
    output: json<{ ok: true }>("{ ok: true }"),
    errors: ["not_session_owner", "not_terminal", "session_not_found", "terminal_ended", "terminal_not_found", "too_many_requests"],
    cli: cmd("session terminal input"),
  }),
});
