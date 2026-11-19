/**
 * P1-06: the routes of packages/daisy/src/app/messages.ts (send, the
 * conversation's answer to a question) and app/identity-switch.ts.
 */
import { z } from "zod";
import { cmd, exempt, group, json, route } from "./route.ts";
import { SendSchema } from "../message.ts";
import { SwitchIdentitySchema } from "../profile.ts";
import type { Session } from "../session.ts";

export const messages = group("session", {
  send: route({
    method: "POST",
    path: "/api/sessions/:id/messages",
    scope: "daisy:session:write",
    idempotent: true,
    body: SendSchema,
    output: json<{ id: string; status: string; duplicate: boolean }>(
      "{ id, status, duplicate }",
    ),
    errors: ["resident_paused", "attachment_not_found", "fork_incomplete", "node_revoked", "not_session_owner", "profile_gone", "profile_logging_in", "queue_full", "session_busy", "session_not_found", "shell_result_not_found", "shell_running"],
    cli: cmd("session send", { args: ["id", "text"] }),
  }),
  answerApproval: route({
    method: "POST",
    path: "/api/sessions/:id/approvals/:aid",
    scope: "daisy:session:write",
    channels: ["web", "device"],
    body: z.object({
      optionId: z.string().describe("api.route.session.answerApproval.field.optionId"),
      answers: z
        .record(z.string(), z.string())
        .optional()
        .describe("api.route.session.answerApproval.field.answers"),
    }),
    output: json<{ ok: true }>("{ ok: true }"),
    errors: ["approval_elsewhere", "approval_closed", "approval_not_found", "approval_option_invalid", "job_gone", "not_session_owner", "session_not_found"],
    cli: exempt(),
  }),
  switchIdentity: route({
    method: "POST",
    path: "/api/sessions/:id/identity",
    scope: "daisy:session:write",
    body: SwitchIdentitySchema,
    output: json<Session>("Session"),
    errors: ["identity_switch_unsupported", "live_busy", "not_session_owner", "profile_agent_mismatch", "profile_node_mismatch", "profile_not_found", "runner_outdated", "session_busy", "session_not_found", "terminal_open"],
    cli: cmd("session identity switch"),
  }),
  freshIdentity: route({
    method: "POST",
    path: "/api/sessions/:id/identity/fresh",
    scope: "daisy:session:write",
    output: json<Session>("Session"),
    errors: ["not_session_owner", "nothing_to_carry", "session_busy", "session_not_found"],
    cli: cmd("session identity fresh"),
  }),
});
