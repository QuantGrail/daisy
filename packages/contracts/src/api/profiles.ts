/**
 * P1-06: identities (profiles) and harness logins — the routes of
 * packages/daisy/src/app/profiles.ts, auth.ts and auto-compact.ts.
 */
import { z } from "zod";
import { cmd, exempt, group, json, route, secretInput } from "./route.ts";
import {
  ModelSlotsSchema,
  ProfileSchema,
  type AutoCompactStatus,
  type Profile,
} from "../profile.ts";
import { ReasoningEffortSchema, ServiceTierSchema } from "../model-options.ts";
import { AgentSchema } from "../session.ts";

/** One harness login flow as its owner sees it (auth.ts `view`). */
export interface LoginFlow {
  id: string;
  profileId: string;
  status:
    | "queued"
    | "running"
    | "waiting"
    | "complete"
    | "error"
    | "cancelled"
    | "expired";
  expiresAt: number;
  message?: string;
  /** The official authorization page to open (waiting). */
  url?: string;
  userCode?: string;
  /** Waiting for the code the page shows (`login input`). */
  needsInput?: boolean;
}

const loginId = z.object({ id: z.string().describe("api.field.profiles.id") });
const profileId = z.object({ id: z.string().describe("api.field.profiles.id2") });

export const profiles = group("profile", {
  create: route({
    method: "POST",
    path: "/api/profiles",
    scope: "daisy:manage",
    body: ProfileSchema,
    output: json<Profile>("Profile"),
    errors: ["api_key_claude_only", "api_key_missing", "base_url_invalid", "model_slots_claude_only", "node_not_found", "node_revoked"],
    cli: cmd("profile create"),
  }),
  createManaged: route({
    method: "POST",
    path: "/api/identities",
    scope: "daisy:manage",
    body: z.object({
      agent: AgentSchema,
      nodeId: z.string().describe("api.route.profile.createManaged.field.nodeId"),
      label: z.string().min(1).max(100).describe("api.route.profile.createManaged.field.label"),
    }),
    output: json<Profile>("Profile"),
    errors: ["login_unsupported", "node_not_found", "node_revoked"],
    cli: cmd("profile create-managed"),
  }),
  update: route({
    method: "PATCH",
    path: "/api/profiles/:id",
    scope: "daisy:manage",
    params: profileId,
    body: z.object({
      // Required before the auto-compact threshold existed; a threshold-only PATCH leaves both alone.
      model: z.string().max(200).optional(),
      reasoningEffort: ReasoningEffortSchema.optional(),
      /** Codex service tier; absent = unchanged (older clients). */
      serviceTier: ServiceTierSchema.optional(),
      permissionMode: z.string().max(80).optional(),
      sandboxMode: z
        .enum(["read-only", "workspace-write", "danger-full-access"])
        .optional(),
      /**
       * Claude Code model slots, the whole set (an empty slot
       * clears it); absent = unchanged.
       */
      modelSlots: ModelSlotsSchema.optional(),
      /** tokens (Claude: the --autocompact window); null = CLI default. */
      autoCompactTokens: z
        .number()
        .int()
        .positive()
        .max(1e9)
        .nullable()
        .optional()
        .describe("api.route.profile.update.field.autoCompactTokens"),
    }),
    output: json<Profile & { autoCompact?: AutoCompactStatus }>("Profile"),
    errors: ["auto_compact_invalid", "model_slots_claude_only", "permission_mode_unsupported", "profile_not_found"],
    cli: cmd("profile update"),
  }),
  delete: route({
    method: "DELETE",
    path: "/api/profiles/:id",
    scope: "daisy:manage",
    params: profileId,
    output: json<{ ok: true; managed: boolean }>("{ ok, managed }"),
    errors: ["profile_busy", "profile_not_found"],
    cli: cmd("profile delete"),
  }),
  autoCompact: route({
    method: "GET",
    path: "/api/profiles/:id/auto-compact",
    scope: "daisy:manage",
    params: profileId,
    output: json<AutoCompactStatus>("AutoCompactStatus"),
    errors: ["profile_not_found"],
    cli: cmd("profile auto-compact show"),
  }),
  autoCompactRestart: route({
    method: "POST",
    path: "/api/profiles/:id/auto-compact/restart",
    scope: "daisy:manage",
    params: profileId,
    output: json<AutoCompactStatus>("AutoCompactStatus"),
    errors: ["profile_not_found"],
    cli: cmd("profile auto-compact restart"),
  }),
  loginStart: route({
    method: "POST",
    path: "/api/profiles/:id/login",
    scope: "daisy:manage",
    params: profileId,
    output: json<LoginFlow>("LoginFlow"),
    errors: ["login_limit", "login_needs_managed_profile", "login_unsupported", "node_revoked", "profile_busy", "profile_not_found"],
    cli: cmd("login start"),
  }),
  logins: route({
    method: "GET",
    path: "/api/logins",
    scope: "daisy:manage",
    output: json<LoginFlow[]>("LoginFlow[]"),
    cli: cmd("login list"),
  }),
  login: route({
    method: "GET",
    path: "/api/logins/:id",
    scope: "daisy:manage",
    params: loginId,
    output: json<LoginFlow>("LoginFlow"),
    errors: ["login_not_found"],
    cli: cmd("login show"),
  }),
  loginInput: route({
    method: "POST",
    path: "/api/logins/:id/input",
    scope: "daisy:manage",
    params: loginId,
    body: z.object({
      code: secretInput(
        z
          .string()
          .min(1)
          .max(2048)
          .regex(/^[^\x00-\x20\x7f]+$/)
          .describe("api.route.profile.loginInput.field.code"),
      ),
    }),
    output: json<{ ok: true }>("{ ok: true }"),
    errors: ["login_no_input", "login_not_found"],
    cli: cmd("login input"),
  }),
  loginCancel: route({
    method: "POST",
    path: "/api/logins/:id/cancel",
    scope: "daisy:manage",
    params: loginId,
    output: json<{ ok: true }>("{ ok: true }"),
    errors: ["login_not_found"],
    cli: cmd("login cancel"),
  }),
});
