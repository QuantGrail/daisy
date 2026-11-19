import { permissionModes } from "../../../contracts/src/acp-harnesses.ts";
import type { FastifyInstance } from "fastify";
import { autoCompactStatus } from "../sessions/auto-compact.ts";
import { id } from "../store/index.ts";
import {
  cleanModelSlots,
  settingsError,
  autoCompactError,
  autoCompactSupport,
} from "../../../contracts/src/index.ts";
import { HttpError, LocalizedError } from "./errors.ts";
import { requestT } from "./language.ts";
import { namedFor } from "../platform/default-names.ts";
import type { Translate } from "../../../contracts/src/i18n.ts";
import { serve } from "./serve.ts";
import { api } from "../../../contracts/src/api/index.ts";
import type { AppBase, AppContext } from "./context.ts";
/** Identities (profiles) (P1-00: moved from app.ts). */
export function profileHelpers(ctx: AppBase) {
  const { store } = ctx;
  /**
   * an identity a conversation switched away from is still in use
   * while its old process runs or the transcript has not been carried from
   * its directory yet; the reason, or "".
   */
  function switchedAway(pid: string) {
    if (
      store.one(
        `SELECT 1 FROM live_sessions l JOIN sessions s ON s.id=l.session_id
         WHERE json_extract(l.data,'$.online')=1
           AND json_extract(s.data,'$.profileId')<>?
           AND (json_extract(l.data,'$.profileId')=?
             -- A process that does not say its identity (older Runner):
             -- it may still be this one.
             OR (json_extract(l.data,'$.profileId') IS NULL
               AND EXISTS(SELECT 1 FROM json_each(s.data,'$.identityPrev') WHERE value=?)))`,
        pid,
        pid,
        pid,
      )
    )
      return "server-app.profile.switchedProcessRunning" as const;
    if (
      store.one(
        "SELECT 1 FROM sessions WHERE json_extract(data,'$.identityMove.from')=?",
        pid,
      )
    )
      return "server-app.profile.switchedNotCarried" as const;
    return null;
  }
  /** the node's Runner can carry a transcript after 换身份. */
  function identityCarry(nodeId: string) {
    const n = store.one("SELECT capabilities FROM nodes WHERE id=?", nodeId);
    try {
      return (
        Number(JSON.parse(n?.capabilities || "{}").identityCarry?.version) >= 1
      );
    } catch {
      return false;
    }
  }
  /** A profile row as a reader sees it (P6-28: a default name in `t`'s language, else the owner's). */
  function profileView(r: any, t?: Translate) {
    const data = JSON.parse(r.data);
    return { ...data, ...namedFor("profile", data.label, t, data.agent), hasSecret: !!r.secret };
  }
  return { switchedAway, identityCarry, profileView };
}
export type ProfileHelpers = ReturnType<typeof profileHelpers>;
/** Identities: create, settings, delete, assign (P1-00: moved from app.ts). */
export function registerProfileRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): void {
  const {
    store,
    user,
    usableNode,
    liveNudge,
    switchedAway,
    profileView,
  } = ctx;
  const P = api.profiles;
  serve(app, P.create, async (req) => {
    const u = user(req),
      b = P.create.body.parse(req.body),
      n = usableNode(u, b.nodeId);
    if (b.authMode === "apiKey" && b.agent !== "claude")
      throw new LocalizedError(400, "api_key_claude_only", "server-app.profile.apiKeyClaudeOnly");
    if (b.authMode === "apiKey" && !b.apiKey)
      throw new LocalizedError(400, "api_key_missing", "server-app.profile.apiKeyMissing");
    if (b.baseUrl && !/^https?:\/\//.test(b.baseUrl))
      throw new LocalizedError(400, "base_url_invalid", "server-app.profile.baseUrlInvalid");
    if (b.modelSlots && b.agent !== "claude")
      throw new LocalizedError(400, "model_slots_claude_only", "server-app.profile.modelSlotsClaudeOnly");
    const pid = id(),
      { apiKey, modelSlots, ...rest } = b,
      slots = cleanModelSlots(modelSlots),
      p = {
        id: pid,
        ownerId: u.id,
        ...rest,
        ...(slots ? { modelSlots: slots } : {}),
      };
    store.run(
      "INSERT INTO profiles VALUES(?,?,?,?,?)",
      pid,
      u.id,
      b.nodeId,
      JSON.stringify(p),
      apiKey ? store.encrypt(apiKey) : "",
    );
    store.audit(u.id, "profile.create", pid);
    return { ...p, hasSecret: !!apiKey };
  });
  serve(app, P.update, async (req) => {
    const u = user(req),
      pid = (req.params as any).id;
    const row = store.one(
      "SELECT * FROM profiles WHERE id=? AND owner_id=?",
      pid,
      u.id,
    );
    if (!row) throw new LocalizedError(404, "profile_not_found", "server-app.profile.notFound");
    const b = P.update.body.parse(req.body);
    // As before: a model without an effort resets the effort.
    if (b.model !== undefined && b.reasoningEffort === undefined)
      b.reasoningEffort = "";
    const profile = JSON.parse(row.data);
    if (b.autoCompactTokens !== undefined) {
      // Checked against what the identity's node can apply (its Runner's state sync).
      const node = store.one(
        "SELECT capabilities FROM nodes WHERE id=?",
        row.node_id,
      );
      const why = autoCompactError(
        b.autoCompactTokens,
        autoCompactSupport(
          JSON.parse(node?.capabilities || "{}"),
          profile.agent,
        ),
      );
      if (why) throw new HttpError(422, why, "auto_compact_invalid");
    }
    // P4-10: the agent's modes (acp-harnesses.ts for every ACP harness).
    if (
      b.permissionMode &&
      !permissionModes(profile.agent).values.includes(b.permissionMode)
    )
      throw new LocalizedError(400, "permission_mode_unsupported", "server-app.profile.permissionModeUnsupported");
    // ultra / service tiers are Codex's.
    const why = settingsError(
      profile.agent,
      { reasoningEffort: b.reasoningEffort, serviceTier: b.serviceTier },
      undefined,
      requestT(req),
    );
    // Said in the request's language (contracts' settingsError takes the translator).
    if (why) throw new HttpError(400, why, "settings_invalid");
    const threshold =
      b.autoCompactTokens !== undefined &&
      (profile.autoCompactTokens ?? null) !== b.autoCompactTokens;
    if (b.modelSlots && profile.agent !== "claude")
      throw new LocalizedError(400, "model_slots_claude_only", "server-app.profile.modelSlotsClaudeOnly");
    const { autoCompactTokens, modelSlots, ...settings } = b;
    // A model save is the whole model setting, as before (absent fields
    // are cleared); a threshold-only PATCH touches nothing else.
    if (b.model !== undefined) Object.assign(profile, settings);
    else
      for (const [k, v] of Object.entries(settings))
        if (v !== undefined) profile[k] = v;
    if (autoCompactTokens !== undefined)
      profile.autoCompactTokens = autoCompactTokens;
    const slots = modelSlots ? cleanModelSlots(modelSlots) : undefined,
      slotsChanged =
        !!modelSlots &&
        JSON.stringify(slots ?? null) !==
          JSON.stringify(profile.modelSlots ?? null);
    if (modelSlots) {
      if (slots) profile.modelSlots = slots;
      else delete profile.modelSlots;
    }
    // never for an identity a reachable AI uses.
    ctx.bypass?.checkProfile(pid, profile);
    store.run(
      "UPDATE profiles SET data=? WHERE id=?",
      JSON.stringify(profile),
      pid,
    );
    // Every save of the model settings is audited, as before auto-compact settings existed —
    // including one that changes only permission / sandbox (review N1).
    if (Object.values(settings).some((v) => v !== undefined))
      store.audit(u.id, "profile.model", pid);
    // New slots reach a process at its next start: its next message
    // restarts it (liveKey), resuming the conversation.
    if (slotsChanged) store.audit(u.id, "profile.model-slots", pid);
    if (threshold) {
      store.audit(u.id, "profile.auto-compact", pid);
      // Its online processes learn the new value at the node's next report.
      liveNudge.add(row.node_id);
    }
    const saved = { ...row, data: JSON.stringify(profile) };
    return {
      ...profileView(saved, requestT(req)),
      ...(b.autoCompactTokens !== undefined
        ? { autoCompact: autoCompactStatus(store, saved) }
        : {}),
    };
  });
  // Delete an identity: owner only, refused while
  // a turn is queued or running; an unfinished login is cancelled. Sessions
  // that used it stay readable but cannot send ("执行身份已删除或重新分配").
  // A managed identity's own CLI directory is listed for its node's runner to
  // remove (state sync retiredIdentities); host logins (configDir "") keep the
  // member's own ~/.claude etc. untouched.
  serve(app, P.delete, async (req) => {
    const u = user(req),
      pid = (req.params as any).id,
      p = store.one(
        "SELECT * FROM profiles WHERE id=? AND owner_id=?",
        pid,
        u.id,
      );
    if (!p) throw new LocalizedError(404, "profile_not_found", "server-app.profile.notFound");
    if (
      store.one(
        "SELECT j.id FROM jobs j JOIN sessions s ON s.id=j.session_id WHERE json_extract(s.data,'$.profileId')=? AND j.status IN ('queued','running')",
        pid,
      )
    )
      throw new LocalizedError(409, "profile_busy", "server-app.profile.busyDelete");
    const switched = switchedAway(pid);
    if (switched) throw new LocalizedError(409, "profile_busy", switched);
    const managed = JSON.parse(p.data).configDir === `managed:${pid}`;
    store.atomic(() => {
      store.run(
        "UPDATE logins SET cancel=1,status='cancelled',data='{}',input='' WHERE profile_id=? AND status IN ('queued','running','waiting')",
        pid,
      );
      store.run("DELETE FROM profiles WHERE id=?", pid);
      if (managed)
        store.run(
          "INSERT OR REPLACE INTO retired_identities VALUES(?,?,?)",
          pid,
          p.node_id,
          Date.now(),
        );
    });
    store.audit(u.id, "profile.delete", pid);
    return { ok: true, managed };
  });
}
