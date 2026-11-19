/**
 * P1-06: the routes of packages/daisy/src/prompts/prompt-layers.ts — a session's
 * own prompt (group session), a person's additions and the admin's
 * layered-prompt settings (group settings).
 */
import { z } from "zod";
import { cmd, group, json, route } from "./route.ts";
import {
  GUIDE_LIMITS,
  PROMPT_OPTIONAL,
  type MyPromptView,
  type PromptLayerAdminView,
  type PromptOptional,
  type SessionPromptView,
} from "../guide.ts";

/** 「立即生效」: how many conversations one batch compacts (default, max). */
export const PROMPT_APPLY_LIMIT = 20;
export const PROMPT_APPLY_LIMIT_MAX = 100;

const ids = z.array(z.string().trim().min(1).max(80)).max(500);
/** PUT /api/admin/prompt-layers (every field optional). */
export const PromptLayerSettingsSchema = z
  .object({
    mode: z.enum(["off", "allowlist", "all"]),
    sessions: ids,
    users: ids,
    staticRules: z.boolean(),
    claudeFresh: z.boolean(),
    freshList: ids,
    orgRead: z.boolean(),
    // 64 hex digits, typed in by an admin ("" clears it).
    orgExpected: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^([0-9a-f]{64})?$/, "api.validation.expectedHash"),
  })
  .partial();
const sectionsShape = Object.fromEntries(
  PROMPT_OPTIONAL.map((k) => [k, z.boolean().nullable().optional()]),
) as Record<PromptOptional, z.ZodOptional<z.ZodNullable<z.ZodBoolean>>>;
const note = z.string().max(GUIDE_LIMITS.noteMax * 2);
/** PUT /api/me/prompt. */
export const MePromptSchema = z
  .object({
    note: note.optional().describe("api.field.prompts.note"),
    sections: z
      .object(sectionsShape)
      .strict()
      .optional()
      .describe("api.field.prompts.sections"),
  })
  .strict();
/** PUT /api/sessions/:id/prompt/extra. */
export const SessionPromptExtraSchema = z
  .object({
    note: note.nullable().optional().describe("api.field.prompts.note2"),
    sections: z
      .object(sectionsShape)
      .strict()
      .optional()
      .describe("api.field.prompts.sections2"),
  })
  .strict();

export const sessionPrompts = group("session", {
  promptShow: route({
    method: "GET",
    path: "/api/sessions/:id/prompt",
    scope: "daisy:session:read",
    output: json<SessionPromptView>("SessionPromptView"),
    errors: ["not_session_owner", "session_not_found"],
    cli: cmd("session prompt show"),
  }),
  promptExtra: route({
    method: "PUT",
    path: "/api/sessions/:id/prompt/extra",
    scope: "daisy:session:write",
    body: SessionPromptExtraSchema,
    output: json<SessionPromptView>("SessionPromptView"),
    errors: ["resident_prompt", "sidecar_prompt", "not_session_owner", "prompt_forged_marker", "prompt_note_too_long", "prompt_too_long", "session_not_found"],
    cli: cmd("session prompt set"),
  }),
  promptApply: route({
    method: "POST",
    path: "/api/sessions/:id/prompt/apply",
    scope: "daisy:session:write",
    output: json<SessionPromptView>("SessionPromptView"),
    errors: ["prompt_apply_refused", "not_session_owner", "session_not_found"],
    cli: cmd("session prompt apply"),
  }),
  promptApplyCancel: route({
    method: "DELETE",
    path: "/api/sessions/:id/prompt/apply",
    scope: "daisy:session:write",
    output: json<SessionPromptView>("SessionPromptView"),
    errors: ["not_session_owner", "session_not_found"],
    cli: cmd("session prompt apply-cancel"),
  }),
});

export const prompts = group("settings", {
  mineShow: route({
    method: "GET",
    path: "/api/me/prompt",
    scope: "daisy:manage",
    output: json<MyPromptView>("MyPromptView"),
    cli: cmd("prompt mine show"),
  }),
  mineSet: route({
    method: "PUT",
    path: "/api/me/prompt",
    scope: "daisy:manage",
    notLetIn: true,
    body: MePromptSchema,
    output: json<MyPromptView>("MyPromptView"),
    errors: ["prompt_forged_marker", "prompt_note_too_long"],
    cli: cmd("prompt mine set"),
  }),
  layersShow: route({
    method: "GET",
    path: "/api/admin/prompt-layers",
    scope: "daisy:manage",
    output: json<PromptLayerAdminView>("PromptLayerAdminView"),
    cli: cmd("prompt layers show"),
  }),
  layersSet: route({
    method: "PUT",
    path: "/api/admin/prompt-layers",
    scope: "daisy:manage",
    notLetIn: true,
    body: PromptLayerSettingsSchema,
    output: json<PromptLayerAdminView>("PromptLayerAdminView"),
    errors: ["org_core_not_ready", "org_core_unverified", "org_expected_hash_required", "prompt_list_unknown", "prompt_pilot_too_many"],
    cli: cmd("prompt layers set"),
  }),
  layersApplyNow: route({
    method: "POST",
    path: "/api/admin/prompt-layers/apply-now",
    scope: "daisy:manage",
    notLetIn: true,
    body: z.object({
      confirm: z.boolean().default(false).describe("api.route.settings.layersApplyNow.field.confirm"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(PROMPT_APPLY_LIMIT_MAX)
        .default(PROMPT_APPLY_LIMIT)
        .describe("api.route.settings.layersApplyNow.field.limit"),
      token: z.string().max(100).optional().describe("api.route.settings.layersApplyNow.field.token"),
    }),
    output: json<PromptLayerAdminView>("PromptLayerAdminView"),
    errors: ["prompt_layers_off", "prompt_apply_busy", "prompt_apply_token"],
    cli: cmd("prompt layers apply"),
  }),
  layersApplyCancel: route({
    method: "POST",
    path: "/api/admin/prompt-layers/apply-cancel",
    scope: "daisy:manage",
    notLetIn: true,
    output: json<PromptLayerAdminView>("PromptLayerAdminView"),
    cli: cmd("prompt layers apply-cancel"),
  }),
  layersForgetNode: route({
    method: "DELETE",
    path: "/api/admin/prompt-layers/nodes/:id",
    scope: "daisy:manage",
    notLetIn: true,
    output: json<PromptLayerAdminView>("PromptLayerAdminView"),
    errors: ["org_guide_none"],
    cli: cmd("prompt layers forget-node"),
  }),
});
