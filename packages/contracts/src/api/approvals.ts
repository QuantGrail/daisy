/** P1-06: the routes of packages/daisy/src/approvals/approvals.ts (the 「审批」 page). */
import { z } from "zod";
import { cmd, exempt, group, json, route } from "./route.ts";
import {
  ApprovalCommentSchema,
  DaisyApprovalRespondSchema,
  type ApprovalThread,
  type ApprovalThreadEntry,
  type ApprovalThreadSummary,
  type DaisyApproval,
} from "../approvals.ts";

export const approvals = group("approval", {
  list: route({
    method: "GET",
    path: "/api/approvals",
    scope: "daisy:session:read",
    query: z.object({
      status: z
        .enum(["pending", "decided", "all"])
        .default("pending")
        .describe("api.route.approval.list.field.status"),
      before: z.coerce
        .number()
        .int()
        .min(0)
        .optional()
        .describe("api.route.approval.list.field.before"),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(200)
        .default(100)
        .describe("api.route.approval.list.field.limit"),
    }),
    output: json<{ items: DaisyApproval[] }>("{ items: DaisyApproval[] }"),
    errors: ["approval_human_only"],
    cli: cmd("approval list"),
  }),
  show: route({
    method: "GET",
    path: "/api/approvals/:aid",
    scope: "daisy:session:read",
    output: json<DaisyApproval & { thread: ApprovalThreadSummary | null }>(
      "DaisyApproval",
    ),
    errors: ["approval_human_only", "approval_not_found"],
    cli: cmd("approval show"),
  }),
  respond: route({
    method: "POST",
    path: "/api/approvals/:aid/respond",
    scope: "daisy:session:write",
    channels: ["web", "device"],
    body: DaisyApprovalRespondSchema,
    output: json<DaisyApproval>("DaisyApproval"),
    errors: ["request_needs_pin", "approval_closed", "approval_expired", "approval_human_only", "approval_not_found", "approval_option_invalid", "approval_option_unknown", "job_gone"],
    cli: exempt(),
  }),
  comments: route({
    method: "GET",
    path: "/api/approvals/:aid/comments",
    scope: "daisy:session:read",
    output: json<ApprovalThread>("ApprovalThread"),
    errors: ["approval_human_only", "approval_not_found"],
    cli: cmd("approval comment list"),
  }),
  comment: route({
    method: "POST",
    path: "/api/approvals/:aid/comments",
    scope: "daisy:session:write",
    idempotent: true,
    body: ApprovalCommentSchema,
    output: json<{ entry: ApprovalThreadEntry }>("{ entry: ApprovalThreadEntry }"),
    errors: ["approval_change_request_forbidden", "approval_comment_control_chars", "approval_comment_rate", "approval_comment_streak", "approval_human_only", "approval_not_found", "approval_thread_full", "approval_thread_too_large", "approval_thread_unsupported"],
    cli: cmd("approval comment add"),
  }),
});
