import { z } from "zod";
import { AGENT_IDS } from "./acp-harnesses.ts";
import type { Agent } from "./session.ts";
import { defaultTranslate } from "./i18n-default.ts";

/**
 * Host branding for the full web app when it runs inside a host product
 * (e.g. an iframe in an organisation's web UI). Configured on the server
 * (DAISY_BRANDING / DAISY_BRANDING_FILE), served by the public
 * `GET /api/health`, applied by the app at boot. Only presentation: colours,
 * radii, fonts, density and a wording preset — never behaviour or secrets.
 */
const BrandColor = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, { error: () => defaultTranslate()("ui-contracts.branding.color") });
const BrandFont = z
  .string()
  .max(300)
  .regex(/^[^;{}<>\\]*$/, { error: () => defaultTranslate()("ui-contracts.branding.font") });
export const HostBrandingSchema = z
  .object({
    /** Product name shown in the browser tab, e.g. "Team UI". */
    name: z.string().trim().min(1).max(40).optional(),
    /** Wording preset: "tool-authorization" calls approvals 工具授权. */
    copy: z.enum(["default", "tool-authorization"]).optional(),
    /** Replaces the product name (names.ts PRODUCT_NAME) in the workspace header and tab title. */
    productName: z.string().trim().min(1).max(40).optional(),
    /** Line under the product name; "" hides it. */
    tagline: z.string().trim().max(60).optional(),
    /** Hide marketing copy, English eyebrows and display-size numbers. */
    hideMarketing: z.boolean().optional(),
    /** `<html lang>` of the web app, following the host (e.g. "zh-CN"). */
    lang: z
      .string()
      .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/)
      .optional(),
    /** Hide Daisy's own execution-node settings; the host manages nodes. */
    hideNodeSettings: z.boolean().optional(),
    /** 「新的工作」: default, hidden, or require-task (must bind a task). */
    newWork: z.enum(["default", "hidden", "require-task"]).optional(),
    /** Shorthand for newWork: "require-task" (newWork wins when both are set). */
    requireTask: z.boolean().optional(),
    /** The embedding product as users know it, e.g. "Team UI" (「← 返回 Team UI」). */
    hostName: z.string().trim().min(1).max(40).optional(),
    /**
     * Where 「← 返回 <hostName>」 leads: a same-site path ("/") or an http(s)
     * URL. The web app only follows it when it is same-origin or listed in
     * DAISY_ORIGINS.
     */
    hostUrl: z
      .string()
      .trim()
      .max(500)
      .regex(
        /^(?:\/(?![/\\])|https?:\/\/)[^\s\\\u0000-\u001f\u007f]*$/i,
        { error: () => defaultTranslate()("ui-contracts.branding.hostUrl") },
      )
      .optional(),
    /**
     * Fallback link for sessions whose task has no `url` (older sessions):
     * a same-site path or http(s) URL with `{id}` for the task id, e.g.
     * "/tasks/{id}". Same origin rules as hostUrl.
     */
    taskUrl: z
      .string()
      .trim()
      .max(500)
      .regex(
        /^(?:\/(?![/\\])|https?:\/\/)[^\s\\\u0000-\u001f\u007f]*\{id\}[^\s\\\u0000-\u001f\u007f]*$/i,
        { error: () => defaultTranslate()("ui-contracts.branding.taskUrl", { id: "{id}" }) },
      )
      .optional(),
    /** Completes 「执行节点…。」 in settings, e.g. 「在 Team UI『我的执行节点』里管理」. */
    nodesHint: z.string().trim().min(1).max(120).optional(),
    /** Hide developer-facing integration notes (docs/EMBEDDING.md); defaults to true in host mode. */
    hideDeveloperInfo: z.boolean().optional(),
    /** 12-hour clock; default 24-hour for Chinese `lang`, else the locale default. */
    hour12: z.boolean().optional(),
    /** Same shape as @daisy-ai/ui `DaisyBrandTokens`. */
    theme: z
      .object({
        background: BrandColor,
        surface: BrandColor,
        text: BrandColor,
        mutedText: BrandColor,
        faintText: BrandColor.optional(),
        border: BrandColor,
        primary: BrandColor,
        primarySoft: BrandColor.optional(),
        onPrimary: BrandColor.optional(),
        subtle: BrandColor.optional(),
        info: BrandColor.optional(),
        danger: BrandColor.optional(),
        warning: BrandColor.optional(),
        success: BrandColor.optional(),
        neutral: BrandColor.optional(),
        focusRing: BrandColor.optional(),
        radius: z.number().min(0).max(24).optional(),
        cardRadius: z.number().min(0).max(32).optional(),
        fontFamily: BrandFont.optional(),
        monoFontFamily: BrandFont.optional(),
        density: z.number().min(0.7).max(1.3).optional(),
        agents: z
          // P4-10: a colour per agent (every ACP harness too).
          .object(
            Object.fromEntries(
              AGENT_IDS.map((a) => [a, BrandColor.optional()]),
            ) as Record<Agent, ReturnType<typeof BrandColor.optional>>,
          )
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type HostBranding = z.infer<typeof HostBrandingSchema>;
