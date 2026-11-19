import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Store } from "../store/index.ts";
import {
  NOTIFICATION_DEVICES,
  PERMANENT_ALERT_REASONS,
  defaultNotificationMatrix,
  notificationAlert,
  notificationKinds,
  kindInLanguage,
  type NotificationKindInfo,
  type NotificationPlatform,
  type NotificationPreferences,
} from "../../../contracts/src/notifications.ts";
import { api } from "../../../contracts/src/api/index.ts";
import { serve } from "../app/serve.ts";
import { requestT } from "../app/language.ts";
import { LocalizedError, type MsgParams } from "../app/errors.ts";
import type { MessageKey } from "../../../contracts/src/i18n.ts";
import { ownerT } from "../platform/language.ts";

/**
 * Notification preferences (P1-01: the session kinds only — group
 * mutes, 「仅提及与关键词」, unread badges and the older
 * settings went with 群聊). One record per person (JSON body): the matrix
 * kind × device, and the platform that mirrors it.
 *
 * P6-14 (ADR-157 § P6-14): the kinds in effect are the core's plus the
 * installed plugins' declared ones (`kinds`). Cells stored for a kind not in
 * effect (its plugin is not installed now) stay in the record untouched but
 * count for nothing — not read, not offered, not writable — and count again
 * once the plugin is back.
 */

const fail = (statusCode: number, code: string, key: MessageKey, params?: MsgParams): never => {
  throw new LocalizedError(statusCode, code, key, params);
};

// P1-06: the request schemas are the route definitions' (contracts api/settings.ts).
/** a mirroring platform that did not say its name. */
const platformName = () => ownerT()("server-sessions.prefs.platformName");
export const preferencesPatchSchema = api.settings.notificationsSet.body;
export const platformMirrorSchema = api.settings.notificationsMirror.body;

export function notificationPreferences(
  store: Store,
  /** The kinds (ids and, for the settings view, labels — said in the owner's language when not given). */
  kinds: readonly NotificationKindInfo[] = notificationKinds([], ownerT()),
) {
  const ids = kinds.map((k) => k.id);
  function raw(uid: string): any {
    const r = store.one(
      "SELECT body FROM notification_preferences WHERE user_id=?",
      uid,
    );
    try {
      return r ? JSON.parse(r.body) || {} : {};
    } catch {
      return {};
    }
  }
  function write(uid: string, body: any) {
    store.run(
      "INSERT INTO notification_preferences(user_id,body) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET body=excluded.body",
      uid,
      JSON.stringify(body),
    );
  }
  /** The person's preferences. */
  function load(uid: string): NotificationPreferences {
    const body = raw(uid);
    const matrix = defaultNotificationMatrix(kinds);
    for (const k of ids)
      for (const d of NOTIFICATION_DEVICES)
        if (typeof body.matrix?.[k]?.[d] === "boolean")
          matrix[k][d] = body.matrix[k][d];
    return {
      revision: Number(body.revision) || 0,
      matrix,
      updated: Number(body.updated) || 0,
      updatedFrom: NOTIFICATION_DEVICES.includes(body.updatedFrom)
        ? body.updatedFrom
        : null,
      managedBy: platformOf(body),
    };
  }
  /** the platform that mirrors its settings here, if any. */
  function platformOf(body: any): NotificationPlatform | null {
    const p = body?.platform;
    if (!p || typeof p.url !== "string" || !p.url) return null;
    return {
      name: typeof p.name === "string" && p.name ? p.name : platformName(),
      url: p.url,
      revision: Number(p.revision) || 0,
      at: Number(p.at) || 0,
    };
  }
  const view = (uid: string): NotificationPreferences => load(uid);
  /** Apply a validated patch; one revision, one audit row. */
  function save(
    uid: string,
    patch: z.infer<typeof preferencesPatchSchema>,
  ): NotificationPreferences {
    return store.atomic(() => {
      const body = raw(uid),
        cur = load(uid);
      if (patch.revision !== undefined && patch.revision !== cur.revision)
        fail(409, "revision_conflict", "server-sessions.prefs.error.revision");
      const changed: string[] = [];
      if (patch.matrix) {
        const unknown = Object.keys(patch.matrix).filter((k) => !ids.includes(k));
        if (unknown.length)
          fail(400, "notification_kind_unknown", "server-sessions.prefs.error.unknown", {
            unknown: unknown.join(ownerT()("server-sessions.prefs.separator")).slice(0, 200),
            ids: ids.join(ownerT()("server-sessions.prefs.separator")),
          });
        const m = { ...(body.matrix || {}) };
        for (const [k, v] of Object.entries(patch.matrix))
          for (const [d, on] of Object.entries(v || {}))
            if (typeof on === "boolean") {
              m[k] = { ...(m[k] || {}), [d]: on };
              changed.push(`matrix.${k}.${d}=${on}`);
            }
        body.matrix = m;
      }
      body.revision = cur.revision + 1;
      body.updated = Date.now();
      body.updatedFrom = patch.device ?? null;
      write(uid, body);
      store.audit(
        uid,
        "notification.preferences",
        JSON.stringify({
          revision: body.revision,
          device: patch.device ?? null,
          changed,
        }).slice(0, 2000),
      );
      return view(uid);
    });
  }
  /**
   * the platform (a host UI) owns the settings and writes its
   * matrix for Daisy's kinds here. Guarded by the Daisy revision it last
   * saw, so a change made here meanwhile (an older client) is never lost:
   * 409, the platform imports it, then mirrors again.
   */
  function mirror(
    uid: string,
    m: z.infer<typeof platformMirrorSchema>,
  ): NotificationPreferences {
    return store.atomic(() => {
      const body = raw(uid),
        cur = load(uid);
      if (m.revision !== cur.revision)
        fail(409, "revision_conflict", "server-sessions.prefs.error.changedHere");
      const matrix: Record<string, Record<string, boolean>> = {
        ...(body.matrix || {}),
      };
      const changed: string[] = [];
      // Only the kinds in effect: one this Daisy does not have now is left out.
      for (const k of ids)
        for (const d of NOTIFICATION_DEVICES) {
          const on = m.matrix[k]?.[d];
          if (typeof on !== "boolean") continue;
          if (cur.matrix[k][d] !== on) changed.push(`matrix.${k}.${d}=${on}`);
          matrix[k] = { ...(matrix[k] || {}), [d]: on };
        }
      body.matrix = matrix;
      const prev = cur.managedBy;
      body.platform = {
        name: m.name || platformName(),
        url: m.settingsUrl,
        revision: m.platformRevision,
        at: Date.now(),
      };
      // Review L8: nothing a reader sees changed (same cells, same owner and page) → no new revision, no audit;
      // only the platform's own revision / time are noted.
      if (
        !changed.length &&
        prev &&
        prev.url === body.platform.url &&
        prev.name === body.platform.name
      ) {
        write(uid, body);
        return view(uid);
      }
      body.revision = cur.revision + 1;
      body.updated = Date.now();
      body.updatedFrom = null;
      write(uid, body);
      store.audit(
        uid,
        "notification.preferences.platform",
        JSON.stringify({
          revision: body.revision,
          platformRevision: m.platformRevision,
          changed,
        }).slice(0, 2000),
      );
      return view(uid);
    });
  }
  /**
   * Review L8: the platform lets go (rollback, Daisy run without its host UI):
   * managedBy is cleared, the matrix stays as last mirrored, the full panel
   * comes back. Same revision guard as the mirror.
   */
  function release(uid: string, revision: number): NotificationPreferences {
    return store.atomic(() => {
      const body = raw(uid),
        cur = load(uid);
      if (revision !== cur.revision)
        fail(409, "revision_conflict", "server-sessions.prefs.error.changedHere");
      if (!cur.managedBy) return view(uid);
      delete body.platform;
      body.revision = cur.revision + 1;
      body.updated = Date.now();
      body.updatedFrom = null;
      write(uid, body);
      store.audit(
        uid,
        "notification.preferences.platform",
        JSON.stringify({ revision: body.revision, released: true }),
      );
      return view(uid);
    });
  }
  /** The kind of a checked item: one in effect, else unknown (null). */
  const category = (c: string | null) => (c && ids.includes(c) ? c : null);
  return { kinds, load, view, save, mirror, release, category };
}
export type NotificationPrefs = ReturnType<typeof notificationPreferences>;

/** Category-level check, shared by the stream and the check endpoint. */
export function alertFor(
  p: NotificationPreferences,
  item: Parameters<typeof notificationAlert>[1],
  now = Date.now(),
) {
  const r = notificationAlert(p, item, now);
  return { ...r, permanent: PERMANENT_ALERT_REASONS.includes(r.reason) };
}

/**
 * GET/PUT/PATCH /api/notification-preferences and POST …/check. People
 * only (an AI's token gets 403); everyone reads and writes their own
 * record only — there is no user parameter.
 */
export function notificationPreferenceRoutes(
  app: FastifyInstance,
  store: Store,
  prefs: NotificationPrefs,
  human: (req: any) => { id: string },
) {
  const N = api.settings;
  serve(app, N.notifications, async (req: any) => ({
    ...prefs.view(human(req).id),
    // Every kind's words in the request's language (a plugin's: its own
    // words for that language when it declared them per language, P6-28).
    kinds: prefs.kinds.map((k) => kindInLanguage(k, requestT(req))),
    devices: NOTIFICATION_DEVICES,
  }));
  const update = async (req: any) => {
    const a = human(req);
    return prefs.save(a.id, preferencesPatchSchema.parse(req.body || {}));
  };
  // PUT and PATCH: one schema (the PATCH definition repeats the PUT's).
  serve(app, N.notificationsSet, update);
  serve(app, N.notificationsPatch, update);
  /**
   * the platform's mirror write (the host UI's server, through the
   * gateway as the person). Only the caller's own record, like PATCH.
   */
  serve(app, N.notificationsMirror, async (req: any) =>
    prefs.mirror(human(req).id, platformMirrorSchema.parse(req.body || {})),
  );
  /** Review L8: clear managedBy (`?revision=` = the Daisy revision last seen). */
  serve(app, N.notificationsRelease, async (req: any) =>
    prefs.release(
      human(req).id,
      N.notificationsRelease.query.shape.revision.parse(req.query?.revision),
    ),
  );
  /** For a sender of items Daisy does not store (the host UI's push). */
  serve(app, N.notificationsCheck, async (req: any) => {
    const a = human(req),
      b = N.notificationsCheck.body.parse(req.body),
      p = prefs.load(a.id);
    return {
      revision: p.revision,
      results: b.items.map((i) =>
        alertFor(p, {
          category: prefs.category(i.category),
          device: b.device,
          expiresAt: i.expiresAt,
        }),
      ),
    };
  });
}
