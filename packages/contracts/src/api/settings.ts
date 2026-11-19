/**
 * P1-06: settings — restart / update of this process
 * (packages/daisy/src/app/update.ts) and the notification preferences
 * (packages/daisy/src/sessions/notification-preferences.ts).
 */
import { z } from "zod";
import { cmd, exempt, group, json, route } from "./route.ts";
import {
  NOTIFICATION_DEVICES,
  NOTIFICATION_KIND_ID,
  type NotificationDevice,
  type NotificationKindInfo,
  type NotificationPreferences,
} from "../notifications.ts";

const devicePatch = z
  .object(
    Object.fromEntries(
      NOTIFICATION_DEVICES.map((d) => [d, z.boolean().optional()]),
    ) as Record<NotificationDevice, z.ZodOptional<z.ZodBoolean>>,
  )
  .strict();
/**
 * P6-14: kind → device → on. The kinds in effect are the core's plus the
 * installed plugins' (known only at run time): the server refuses any
 * other kind (400) — the platform mirror leaves it out.
 */
const kindId = z.string().regex(NOTIFICATION_KIND_ID);
const matrixPatch = () =>
  z
    .record(kindId, devicePatch)
    .refine((m) => Object.keys(m).length <= 64, "api.validation.tooManyKinds");
/** a change to the matrix kind × device. */
export const NotificationPreferencesPatchSchema = z
  .object({
    revision: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("api.field.settings.revision"),
    device: z.enum(NOTIFICATION_DEVICES).optional().describe("api.field.settings.device"),
    matrix: matrixPatch().optional().describe("api.field.settings.matrix"),
  })
  .strict();
/** a same-origin path or an http(s) URL, nothing else. */
const settingsUrl = z
  .string()
  .max(300)
  .refine(
    (u) => /^\/(?!\/)[^\s]*$/.test(u) || /^https?:\/\/[^\s]+$/.test(u),
    "api.validation.settingsUrl",
  );
/** the platform's mirror write. */
export const NotificationPlatformMirrorSchema = z
  .object({
    revision: z.number().int().min(0),
    matrix: matrixPatch(),
    platformRevision: z.number().int().min(0),
    settingsUrl,
    name: z.string().min(1).max(40).optional(),
  })
  .strict();

/** Why the platform's mirror routes have no command (a shared pack key). */
const PLATFORM_ONLY = "api.exempt.platformOnly";

type PreferencesView = NotificationPreferences & {
  kinds: Omit<NotificationKindInfo, "default">[];
  devices: readonly NotificationDevice[];
};

/**
 * P1-09 (ADR-112 §4): start at boot, as the web page's settings see it. The
 * same logic as `daisy autostart` (packages/daisy/src/platform/autostart.ts).
 */
export const AutostartViewSchema = z.object({
  supported: z.boolean().describe("api.field.settings.supported"),
  enabled: z.boolean().describe("api.field.settings.enabled"),
  manager: z
    .enum(["systemd-user", "launchd", "windows-run"])
    .nullable()
    .describe("api.field.settings.manager"),
  unit: z.string().optional().describe("api.field.settings.unit"),
  reason: z.string().optional().describe("api.field.settings.reason"),
  linger: z.boolean().nullable().optional().describe("api.field.settings.linger"),
  hint: z.string().optional().describe("api.field.settings.hint"),
});
export type AutostartView = z.output<typeof AutostartViewSchema>;

const AUTOSTART_CLI = "api.exempt.autostart";

/** P5-06: check / apply are the local command `daisy update` (it works when Daisy is not running too). */
const UPDATE_CLI = "api.exempt.update";

/** P6-20: the display language (GET / PUT /api/settings/language). */
export const LanguageViewSchema = z.object({
  /** The owner's setting; null = follow the system. */
  setting: z.string().nullable(),
  /** What Daisy speaks now when a client does not ask (the setting, else the system's). */
  effective: z.string(),
  /** The system's language among the available ones (null: nothing matched → English). */
  system: z.string().nullable(),
  /** The packs present: `{ lang, name }`, the fallback first. */
  available: z.array(z.object({ lang: z.string(), name: z.string() })),
});
export type LanguageView = z.output<typeof LanguageViewSchema>;

export const settings = group("settings", {
  autostartStatus: route({
    method: "GET",
    path: "/api/autostart",
    scope: "daisy:manage",
    output: json(AutostartViewSchema, "AutostartView"),
    cli: exempt(AUTOSTART_CLI),
  }),
  autostartSet: route({
    method: "PUT",
    path: "/api/autostart",
    scope: "daisy:manage",
    notLetIn: true,
    body: z.object({ enabled: z.boolean().describe("api.route.settings.autostartSet.field.enabled") }).strict(),
    output: json(AutostartViewSchema, "AutostartView"),
    errors: ["autostart_failed"],
    cli: exempt(AUTOSTART_CLI),
  }),
  updateStatus: route({
    method: "GET",
    path: "/api/update",
    scope: "daisy:manage",
    output: json<Record<string, unknown>>(
      "{ release, runner, supervised, update, request, idle, waitingFor, summary, package }",
    ),
    cli: cmd("restart status"),
  }),
  updateCheck: route({
    method: "POST",
    path: "/api/update/check",
    scope: "daisy:manage",
    notLetIn: true,
    output: json<Record<string, unknown>>("{ package: PackageStatus }"),
    errors: ["update_unavailable"],
    cli: exempt(UPDATE_CLI),
  }),
  updateApply: route({
    method: "POST",
    path: "/api/update/apply",
    scope: "daisy:manage",
    notLetIn: true,
    body: z
      .object({
        from: z.string().min(1).max(4096).optional().describe("api.route.settings.updateApply.field.from"),
        allowDowngrade: z.boolean().optional().describe("api.route.settings.updateApply.field.allowDowngrade"),
      })
      .strict(),
    output: json<Record<string, unknown>>("{ package: PackageStatus, waitingFor }"),
    errors: ["update_unavailable"],
    cli: exempt(UPDATE_CLI),
  }),
  updateSourceSet: route({
    method: "PUT",
    path: "/api/update/source",
    scope: "daisy:manage",
    pin: true,
    notLetIn: true,
    body: z
      .object({
        source: z.string().min(1).max(4096).nullable().describe("api.route.settings.updateSourceSet.field.source"),
      })
      .strict(),
    output: json<Record<string, unknown>>("{ package: PackageStatus }"),
    errors: ["update_unavailable", "invalid_source", "runner_json_untrusted", "runner_json_broken"],
    cli: exempt(UPDATE_CLI),
  }),
  updateRestart: route({
    method: "POST",
    path: "/api/update/restart",
    scope: "daisy:manage",
    notLetIn: true,
    body: z.object({
      mode: z
        .enum(["idle", "now"])
        .default("idle")
        .describe("api.route.settings.updateRestart.field.mode"),
      /** The token a 409 gave for the list the owner saw. */
      confirm: z
        .string()
        .min(1)
        .max(64_000)
        .optional()
        .describe("api.route.settings.updateRestart.field.confirm"),
    }),
    output: json<Record<string, unknown>>("{ request, interrupts?, waitingFor }"),
    errors: ["restart_interrupts", "restart_unavailable"],
    cli: cmd("restart request"),
  }),
  updateCancel: route({
    method: "DELETE",
    path: "/api/update/restart",
    scope: "daisy:manage",
    notLetIn: true,
    output: json<{ ok: true; cancelled: boolean }>("{ ok, cancelled }"),
    cli: cmd("restart cancel"),
  }),
  notifications: route({
    method: "GET",
    path: "/api/notification-preferences",
    scope: "daisy:manage",
    output: json<PreferencesView>("NotificationPreferences & { kinds, devices }"),
    cli: cmd("notify show"),
  }),
  notificationsSet: route({
    method: "PUT",
    path: "/api/notification-preferences",
    scope: "daisy:manage",
    notLetIn: true,
    body: NotificationPreferencesPatchSchema,
    output: json<NotificationPreferences>("NotificationPreferences"),
    errors: ["notification_kind_unknown", "revision_conflict"],
    cli: cmd("notify set"),
  }),
  notificationsPatch: route({
    method: "PATCH",
    path: "/api/notification-preferences",
    scope: "daisy:manage",
    notLetIn: true,
    body: NotificationPreferencesPatchSchema,
    output: json<NotificationPreferences>("NotificationPreferences"),
    errors: ["notification_kind_unknown", "revision_conflict"],
    cli: exempt(),
  }),
  notificationsMirror: route({
    method: "PUT",
    path: "/api/notification-preferences/platform",
    scope: "daisy:manage",
    notLetIn: true,
    body: NotificationPlatformMirrorSchema,
    output: json<NotificationPreferences>("NotificationPreferences"),
    errors: ["revision_conflict"],
    cli: exempt(PLATFORM_ONLY),
  }),
  notificationsRelease: route({
    method: "DELETE",
    path: "/api/notification-preferences/platform",
    scope: "daisy:manage",
    notLetIn: true,
    query: z.object({
      revision: z.coerce
        .number()
        .int()
        .min(0)
        .describe("api.route.settings.notificationsRelease.field.revision"),
    }),
    output: json<NotificationPreferences>("NotificationPreferences"),
    errors: ["revision_conflict"],
    cli: exempt(PLATFORM_ONLY),
  }),
  notificationsCheck: route({
    method: "POST",
    path: "/api/notification-preferences/check",
    audit: false,
    scope: "daisy:manage",
    notLetIn: true,
    body: z
      .object({
        device: z.enum(NOTIFICATION_DEVICES),
        items: z
          .array(
            z
              .object({
                category: kindId.nullable(),
                expiresAt: z.number().min(0).optional(),
              })
              .strict(),
          )
          .max(200),
      })
      .strict(),
    output: json<{ revision: number; results: unknown[] }>("{ revision, results }"),
    cli: exempt(),
  }),
  // P6-20 (ADR-159 §2): the owner's display language. The English text of
  // these two is in the packs (`api.route.settings.language*`).
  languageShow: route({
    method: "GET",
    path: "/api/settings/language",
    scope: "daisy:manage",
    output: json(LanguageViewSchema, "LanguageView"),
    cli: cmd("language show"),
  }),
  languageSet: route({
    method: "PUT",
    path: "/api/settings/language",
    scope: "daisy:manage",
    notLetIn: true,
    body: z
      .object({
        language: z
          .string()
          .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/)
          .nullable()
          .describe("api.route.settings.languageSet.field.language"),
      })
      .strict(),
    output: json(LanguageViewSchema, "LanguageView"),
    errors: ["language_unknown"],
    cli: cmd("language set", { args: ["language"] }),
  }),
});

