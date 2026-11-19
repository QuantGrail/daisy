/**
 * Notifications (P1-01: only what belongs to sessions is left —
 * 群聊's kinds, 群免打扰, 仅提及, 未读数字 and 通知中心's history went
 * with 群聊): one registry of
 * notification kinds, per-person preferences (kind × device) and the pure
 * rule that decides whether an item alerts on a device.
 *
 * The server's `notification_events` outbox stays the only stream. Writers
 * (packages/daisy/src/sessions/notifications.ts `notificationWriter`) store a kind
 * from this registry; it is the source for the local web page's
 * notifications and, later, the event outlet. Retract events close an
 * item on every device and are never filtered.
 */

/**
 * The registry: the core's own kinds. Order = UI order. P6-14 (ADR-157
 * § P6-14): a plugin's kinds are not here — an installed plugin declares
 * them through the plugin seam (`notificationKinds`) and they follow these
 * (`notificationKinds()`).
 */
import { FALLBACK_LANG, LANG_TAG, matchLang, type Lang, type Translate } from "./i18n.ts";
import { defaultTranslate } from "./i18n-default.ts";

export const NOTIFICATION_KINDS = [
  "approval",
  "task",
  "ai_private_message",
  "ai_failed",
] as const;
/** A kind of the core's. */
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
/** A kind id: one of the core's, or one an installed plugin declares. */
export type NotificationKindId = string;

export const NOTIFICATION_DEVICES = ["web", "mobile"] as const;
export type NotificationDevice = (typeof NOTIFICATION_DEVICES)[number];

/**
 * What a person sees in the settings matrix for a core kind, in `t`'s
 * language (`ui-contracts.notify.<kind>.label` / `.hint`).
 */
export function notificationKindInfo(
  kind: NotificationKind,
  t: Translate = defaultTranslate(),
): { label: string; hint: string } {
  return {
    label: t.dynamic(`ui-contracts.notify.${kind}.label`),
    hint: t.dynamic(`ui-contracts.notify.${kind}.hint`),
  };
}

/** The form of a kind id (a plugin's too). */
export const NOTIFICATION_KIND_ID = /^[a-z][a-z0-9_]{0,31}$/;

/**
 * Words a plugin gives people (P6-28): one string (shown as written in
 * every language), or the same words per language keyed by language tag —
 * `{ en: "Greeting", "zh-CN": "问候" }`. A reader gets its own language's
 * (the closest tag: `zh-Hans` → `zh-CN`), else English, else the first.
 */
export type PluginText = string | Readonly<Record<Lang, string>>;

/** A plugin's words in `lang` (see `PluginText`); "" for none. */
export function pluginText(text: PluginText | undefined, lang: Lang): string {
  if (text === undefined) return "";
  if (typeof text === "string") return text;
  const tags = Object.keys(text);
  const m = matchLang(lang, tags) ?? (FALLBACK_LANG in text ? FALLBACK_LANG : tags[0]);
  return m === undefined ? "" : String(text[m] ?? "");
}

/** Whether `v` is plugin words of at most `max` characters (`min`: not empty). */
function isPluginText(v: unknown, max: number, min: boolean): boolean {
  const ok = (s: unknown) => typeof s === "string" && s.length <= max && (!min || !!s.trim());
  if (typeof v === "string") return ok(v);
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const e = Object.entries(v);
  return e.length > 0 && e.every(([k, s]) => LANG_TAG.test(k) && ok(s));
}

/**
 * A kind a plugin declares (DaisyServerPlugin `notificationKinds`): its id,
 * what a person sees (one string, or per language — `PluginText`), and
 * whether it is on by default (both devices; default on).
 */
export interface NotificationKindDecl {
  id: string;
  label: PluginText;
  hint?: PluginText;
  default?: boolean;
}
/** One kind of the registry in effect. */
export interface NotificationKindInfo {
  id: NotificationKindId;
  /** In the language the registry was built in (`kindInLanguage` says it in another). */
  label: string;
  hint: string;
  default: boolean;
  /** A plugin's kind: its words as declared. */
  declared?: { label: PluginText; hint?: PluginText };
}

/** A kind of the registry in effect, its words in `t`'s language. */
export function kindInLanguage(k: NotificationKindInfo, t: Translate): { id: string; label: string; hint: string } {
  if ((NOTIFICATION_KINDS as readonly string[]).includes(k.id))
    return { id: k.id, ...notificationKindInfo(k.id as NotificationKind, t) };
  return k.declared
    ? { id: k.id, label: pluginText(k.declared.label, t.lang), hint: pluginText(k.declared.hint, t.lang) }
    : { id: k.id, label: k.label, hint: k.hint };
}

/**
 * The kinds in effect: the core's, then the declared ones in order. Throws
 * on a declaration that is malformed, a core kind's or declared twice.
 */
export function notificationKinds(
  declared: readonly NotificationKindDecl[] = [],
  t: Translate = defaultTranslate(),
): NotificationKindInfo[] {
  const list: NotificationKindInfo[] = NOTIFICATION_KINDS.map((id) => ({
    id,
    ...notificationKindInfo(id, t),
    default: true,
  }));
  const seen = new Set<string>([...NOTIFICATION_KINDS, NOTIFICATION_RETRACT_KIND]);
  for (const d of declared) {
    const id = String(d?.id ?? "");
    const bad = (why: "badId" | "taken" | "label" | "hint" | "default"): never => {
      throw Error(t.dynamic(`ui-contracts.notify.decl.${why}`, { id: id.slice(0, 40) }));
    };
    if (!NOTIFICATION_KIND_ID.test(id)) bad("badId");
    if (seen.has(id)) bad("taken");
    if (!isPluginText(d.label, 40, true)) bad("label");
    if (d.hint !== undefined && !isPluginText(d.hint, 200, false)) bad("hint");
    if (d.default !== undefined && typeof d.default !== "boolean") bad("default");
    seen.add(id);
    list.push({
      id,
      label: pluginText(d.label, t.lang),
      hint: pluginText(d.hint, t.lang),
      default: d.default ?? true,
      declared: { label: d.label, ...(d.hint !== undefined ? { hint: d.hint } : {}) },
    });
  }
  return list;
}

export type NotificationOp = "create" | "update" | "retract";
/** Business state of an item, computed live by the server. */
export type NotificationState =
  "unread" | "read" | "pending" | "handled" | "canceled" | "expired";
/** Why an item was closed (a retract event's `state`). */
export type NotificationClose = "handled" | "canceled" | "expired";
/** The kind stored on retract rows. */
export const NOTIFICATION_RETRACT_KIND = "retract";

export const isNotificationKind = (k: unknown): k is NotificationKind =>
  typeof k === "string" &&
  (NOTIFICATION_KINDS as readonly string[]).includes(k);

/** The registry kind of a stored kind; null: unknown (alerts unless retracted or expired). */
export function notificationCategory(kind: string): NotificationKind | null {
  return isNotificationKind(kind) ? kind : null;
}

/** kind × device, for the kinds in effect (the core's always). */
export type NotificationMatrix = Record<NotificationKind, Record<NotificationDevice, boolean>> &
  Record<NotificationKindId, Record<NotificationDevice, boolean>>;

/** Each kind's default (the core's: everything on). */
export const defaultNotificationMatrix = (
  kinds: readonly Pick<NotificationKindInfo, "id" | "default">[] = notificationKinds(),
): NotificationMatrix =>
  Object.fromEntries(
    kinds.map((k) => [k.id, { web: k.default, mobile: k.default }]),
  ) as NotificationMatrix;

/*
 * No time-based do-not-disturb (2026-11-03: 「不要做免打扰功能 让用户自己
 * 在手机上开免打扰就好」): the phone's own Focus / DND does that.
 */

/** One record per person, edited from any device (GET/PUT/PATCH). */
export interface NotificationPreferences {
  /** Bumped on every change; send it back to refuse a lost update (409). */
  revision: number;
  matrix: NotificationMatrix;
  /** Last change: when and from which device (audit has the rest). */
  updated: number;
  updatedFrom: NotificationDevice | null;
  /**
   * The platform (a host UI) owns this person's notification
   * settings and mirrors the matrix here; set by the platform's first mirror
   * write. Absent / null = standalone (this record is the only one).
   */
  managedBy?: NotificationPlatform | null;
}
/** Who owns the settings and where people edit them. */
export interface NotificationPlatform {
  name: string;
  /** Same-origin path or http(s) URL of the platform's 通知设置 page. */
  url: string;
  /** The platform's own revision of what was mirrored. */
  revision: number;
  /** When it was mirrored (ms). */
  at: number;
}
/**
 * PUT /api/notification-preferences/platform: the platform
 * writes its matrix. `revision` is the revision the platform last saw (409
 * when it changed since: import first, then mirror again).
 */
export interface NotificationPlatformMirror {
  revision: number;
  matrix: NotificationMatrix;
  platformRevision: number;
  settingsUrl: string;
  name?: string;
}

/** PUT / PATCH body: every field optional; omitted = unchanged. */
export interface NotificationPreferencesPatch {
  revision?: number;
  device?: NotificationDevice;
  /** Only kinds in effect (400 otherwise). */
  matrix?: Record<
    NotificationKindId,
    Partial<Record<NotificationDevice, boolean>>
  >;
}

/** Reasons that stay true until the settings change (drop, do not retry). */
export const PERMANENT_ALERT_REASONS: readonly NotificationAlertReason[] = [
  "retract",
  "closed",
  "expired",
  "kind-off",
];

export type NotificationAlertReason =
  | "ok"
  | "retract"
  /** Already read, handled or canceled. */
  | "closed"
  | "expired"
  | "kind-off";

/**
 * Does this item alert (banner / sound / push) on this device now? The one
 * rule every reader applies. Retracts always pass through (as `alert:
 * false`, reason "retract") — the caller must deliver them.
 */
export function notificationAlert(
  p: Pick<NotificationPreferences, "matrix">,
  item: {
    /** A kind in effect; null (or one not in the matrix): unknown. */
    category: NotificationKindId | null;
    device: NotificationDevice;
    op?: NotificationOp;
    expiresAt?: number;
  },
  now = Date.now(),
): { alert: boolean; reason: NotificationAlertReason } {
  const no = (reason: NotificationAlertReason) => ({ alert: false, reason });
  if (item.op === "retract") return no("retract");
  if (item.expiresAt && item.expiresAt <= now) return no("expired");
  const c = item.category;
  if (c && p.matrix[c]?.[item.device] === false) return no("kind-off");
  return { alert: true, reason: "ok" };
}

/**
 * One item of a person's notifications. `id` is the outbox sequence
 * (cursor, read receipts); `notificationId` is stable across revisions and
 * is what push, collapse and retract use.
 */
export interface NotificationItem {
  id: string;
  notificationId: string;
  op: NotificationOp;
  revision: number;
  /** Registry kind (null: unknown kind). */
  category: NotificationKindId | null;
  /** Stored kind. */
  kind: string;
  state: NotificationState;
  title: string;
  /** The session it is about ("" when none). */
  sessionId: string;
  subject: string;
  actionRequired: boolean;
  /** Items with the same key may be shown as one (e.g. one session). */
  collapseKey: string;
  /** After this (ms) the item is moot; 0 = never. */
  expiresAt: number;
  created: number;
  /** Only when a device was asked for. */
  alert?: boolean;
  alertReason?: NotificationAlertReason;
}
