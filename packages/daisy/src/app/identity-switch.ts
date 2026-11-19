import type { FastifyInstance } from "fastify";
import { LocalizedError } from "./errors.ts";
import { ownerT } from "../platform/language.ts";
import { serve } from "./serve.ts";
import { api } from "../../../contracts/src/api/index.ts";
import type { AppContext } from "./context.ts";
/** 「换身份」 and 「不带历史继续」 (P1-00: moved from app.ts). */
export function registerIdentitySwitchRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): void {
  const {
    opts,
    store,
    user,
    session,
    identityCarry,
    forViewer,
    publish,
    touched,
  } = ctx;
  /**
   * 「换身份」: the conversation continues with another identity
   * of its owner — same Agent (Claude Code), same node. Not while a turn is
   * queued or running. The conversation's own model choice is cleared (the
   * new identity's model applies; its effort is kept); an online process
   * ends once idle and the next message starts the new identity, resuming
   * the same conversation (its transcript carried over by the Runner).
   */
  const M = api.messages;
  serve(app, M.switchIdentity, async (req) => {
    const u = user(req),
      s0 = session(req, (req.params as any).id),
      b = M.switchIdentity.body.parse(req.body);
    if (s0.ownerId !== u.id)
      throw new LocalizedError(403, "not_session_owner", "server-app.identity.ownerOnly");
    if (s0.agent !== "claude")
      throw new LocalizedError(400, "identity_switch_unsupported", "server-app.identity.claudeOnly");
    if (s0.archived) throw new LocalizedError(409, "session_archived", "server-app.session.archived");
    const target = store.one(
      "SELECT * FROM profiles WHERE id=? AND owner_id=?",
      b.profileId,
      u.id,
    );
    if (!target) throw new LocalizedError(404, "profile_not_found", "server-app.profile.notFound");
    const tp = JSON.parse(target.data);
    if (tp.agent !== s0.agent)
      throw new LocalizedError(400, "profile_agent_mismatch", "server-app.identity.sameAgent");
    if (ctx.bypass?.reachable(s0))
      ctx.bypass.checkOpen(tp, s0.kind === "resident");
    if (target.node_id !== s0.nodeId)
      throw new LocalizedError(400, "profile_node_mismatch", "server-app.identity.sameNode");
    // An older Runner would ignore the carry (and never report it).
    if (!identityCarry(s0.nodeId))
      throw new LocalizedError(409, "runner_outdated", "server-app.identity.runnerOutdated");
    // Everything below in one transaction (synchronous): two switches at
    // once see each other's result.
    const done = store.atomic(() => {
      const s = store.session(s0.id)!;
      if (b.profileId === s.profileId) return null;
      if (s.archived) throw new LocalizedError(409, "session_archived", "server-app.session.archived");
      const job = store.one(
        `SELECT j.id, json_extract(o.data,'$.name') op FROM jobs j
         LEFT JOIN job_operations o ON o.job_id=j.id
         WHERE j.session_id=? AND j.status IN ('running','pending','queued')
         ORDER BY (json_extract(o.data,'$.name')='terminal') DESC LIMIT 1`,
        s.id,
      );
      if (job?.op === "terminal")
        throw new LocalizedError(409, "terminal_open", "server-app.identity.terminalOpen");
      if (job)
        throw new LocalizedError(409, "session_busy", "server-app.identity.turnRunning");
      // An Agent-started turn has no job row; background work and timers
      // would keep running under the old identity.
      if (s.live?.online && (s.live.busy || s.live.pending?.length))
        throw new LocalizedError(409, "live_busy", "server-app.identity.liveBusy");
      opts.identitySwitchHook?.(s.id);
      const previous = s.profileId;
      s.identityPrev = [
        ...(s.identityPrev || []).filter((x) => x !== previous),
        previous,
      ].slice(-10);
      // The identity whose directory holds the transcript: the original one
      // while an earlier switch has not been carried yet (A→B→C: from A).
      const origin = s.identityMove?.from ?? previous;
      s.profileId = b.profileId;
      const old = store.one(
        "SELECT node_id,data FROM profiles WHERE id=?",
        origin,
      );
      const dir = (data: string) => String(JSON.parse(data).configDir || "");
      // Only when there is something to carry: a native conversation, the
      // old identity still on this node, another directory.
      if (
        origin !== b.profileId &&
        s.nativeId &&
        old &&
        old.node_id === s.nodeId &&
        dir(old.data) !== dir(target.data)
      )
        s.identityMove = { from: origin, at: Date.now() };
      else delete s.identityMove;
      if (s.settings?.model) {
        const { model: _m, ...rest } = s.settings;
        s.settings = rest;
      }
      // The old identity's quota is not this one's: the next turn reports.
      delete (s as any).quota;
      s.updatedAt = Date.now();
      store.save(s);
      return { saved: s, from: previous };
    });
    if (!done) return forViewer(req, s0.ownerId, store.session(s0.id)!);
    const { saved, from } = done;
    const label = (pid: string) => {
      const r = store.one("SELECT data FROM profiles WHERE id=?", pid);
      return r ? String(JSON.parse(r.data).label || "") : t("server-app.identity.deletedProfile");
    };
    // A notice kept in the conversation: said once, in the owner's language.
    const t = ownerT();
    store.audit(u.id, "session.identity", saved.id);
    publish(saved.id, "item", {
      id: `identity:${saved.updatedAt}`,
      kind: "notice",
      category: "lifecycle",
      name: t("server-app.identity.switchedName"),
      text: t("server-app.identity.switched", { from: label(from), to: label(b.profileId) }),
      status: "complete",
      createdAt: Date.now(),
    });
    touched(saved.id);
    return forViewer(req, saved.ownerId, saved);
  });
  /**
   * 「不带历史继续」 — the transcript cannot be carried (too big,
   * gone from the old identity, a refused link…) and the old identity is
   * not to be used: the owner gives the native history up. The switch is
   * forgotten and the next message starts a new native conversation (the
   * conversation view keeps every item; the AI does not remember them).
   */
  serve(app, M.freshIdentity, async (req) => {
    const u = user(req),
      s0 = session(req, (req.params as any).id);
    if (s0.ownerId !== u.id)
      throw new LocalizedError(403, "not_session_owner", "server-app.session.ownerOnly");
    const saved = store.atomic(() => {
      const s = store.session(s0.id)!;
      if (!s.identityMove)
        throw new LocalizedError(409, "nothing_to_carry", "server-app.identity.nothingToCarry");
      if (
        store.one(
          "SELECT 1 FROM jobs WHERE session_id=? AND status IN ('running','pending','queued')",
          s.id,
        )
      )
        throw new LocalizedError(409, "session_busy", "server-app.session.turnRunning");
      delete s.identityMove;
      s.nativeId = null;
      // The new native conversation gets the task context again.
      s.contextDelivered = false;
      s.updatedAt = Date.now();
      store.save(s);
      return s;
    });
    store.audit(u.id, "session.identity-fresh", saved.id);
    publish(saved.id, "item", {
      id: `identity-fresh:${saved.updatedAt}`,
      kind: "notice",
      category: "lifecycle",
      name: ownerT()("server-app.identity.freshName"),
      text: ownerT()("server-app.identity.fresh"),
      status: "complete",
      createdAt: Date.now(),
    });
    touched(saved.id);
    return forViewer(req, saved.ownerId, saved);
  });
}
