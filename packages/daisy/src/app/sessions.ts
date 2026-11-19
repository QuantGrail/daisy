import type { FastifyInstance } from "fastify";
import { sessionT as promptSessionT } from "../../../contracts/src/prompt-i18n.ts";
import { z } from "zod";
import {
  id,
  parseSessionRecord,
  VISIBLE_PAGE_DEFAULT,
  VISIBLE_PAGE_MAX,
} from "../store/index.ts";
import {
  CreateSessionSchema,
  settingsError,
  untitledTitle,
  type Session,
  type User,
} from "../../../contracts/src/index.ts";
import { requireFeatures, sessionFeatures } from "../sessions/features.ts";
import { HttpError, LocalizedError } from "./errors.ts";
import { ownerT } from "../platform/language.ts";
import { requestT } from "./language.ts";
import { newSessionLang } from "../prompts/lang.ts";
import { serve } from "./serve.ts";
import { api } from "../../../contracts/src/api/index.ts";
import type { AppBase, AppContext, LateServices } from "./context.ts";
import type { OwnerHelpers } from "./owner.ts";
import type { NodeAccess } from "./nodes.ts";
/**
 * Who may open a conversation, and what a non-owner sees of it (P1-00:
 * moved from app.ts).
 */
/**
 * An AI conversation as `GET /api/sessions` lists it (the ring
 * reads the session snapshot; lists stay lean).
 */
export function sessionListView(data: string): Record<string, any> {
  const { context: _c, quota: _q, ...s } = parseSessionRecord(data) as any;
  return s;
}
export function sessionAccess(ctx: AppBase & OwnerHelpers) {
  const { store, user } = ctx;
  /**
   * plan quota is the identity owner's. Whatever a non-owner
   * (an admin when adminPrivate is off) reads of a conversation — snapshot,
   * item pages, events, recoveries, the PATCH answer — has the session's
   * `quota` removed (`quotaHidden: true`) and every `<jid>:quota` item
   * emptied. Walks the usual shapes: session, items, events, data.
   */
  function hideQuota(x: any, depth = 0): any {
    if (!x || typeof x !== "object" || depth > 6) return x;
    if (Array.isArray(x)) return x.map((v) => hideQuota(v, depth + 1));
    // Also the raw Codex rate-limit item older Runners wrote
    // (`<jid>:usage:account/rateLimits/updated:<thread>`, credits and plan
    // in its text; review N item 2).
    if (
      x.category === "usage" &&
      typeof x.id === "string" &&
      (x.id.endsWith(":quota") || x.id.includes(":usage:account/rateLimits/"))
    )
      return { ...x, input: undefined, text: "" };
    // what a session gets as its prompt is its owner's alone —
    // the launch audit holds the whole system-layer text (her notes too).
    if (
      x.category === "audit" &&
      typeof x.id === "string" &&
      x.id.endsWith(":launch-audit")
    )
      return { ...x, input: undefined, text: "" };
    let out = x;
    for (const k of ["session", "items", "events", "data"])
      if (k in x) {
        const v = hideQuota(x[k], depth + 1);
        if (v !== x[k]) out = { ...out, [k]: v };
      }
    if (typeof x.ownerId === "string" && typeof x.agent === "string") {
      // …and so are her own additions to it (`promptExtra`).
      const { quota: _q, promptExtra: _p, ...rest } = out;
      out = { ...rest, quotaHidden: true };
    }
    return out;
  }
  const forViewer = <T>(req: any, ownerId: string, x: T): T =>
    user(req).id === ownerId ? x : hideQuota(x);
  function session(req: any, sid: string) {
    const u = user(req),
      s = store.session(sid);
    if (!s || s.deleting) throw new LocalizedError(404, "session_not_found", "server-app.session.notFound");
    // P1-03: every row is the one owner's; one that is not (a database
    // from before single-owner) is not reachable.
    if (s.ownerId !== u.id) throw new LocalizedError(403, "not_session_owner", "server-app.session.forbidden");
    return s;
  }
  return { hideQuota, forViewer, session };
}
export type SessionAccess = ReturnType<typeof sessionAccess>;
/** Creating a conversation (P1-00: moved from app.ts). */
export function sessionHelpers(ctx: AppBase & LateServices & NodeAccess) {
  const { store, usableNode } = ctx;
  /**
   * Create an AI conversation for `u` (POST /api/sessions; the
   * resident wizard too, with `extra` merged into the new record). Every
   * creation path passes the bypass check here: a conversation
   * others can reach — and any resident — never starts on an identity in
   * bypassPermissions.
   */
  function createSession(
    u: User,
    b: z.infer<typeof CreateSessionSchema>,
    extra: Partial<Session> = {},
  ): Session & { duplicate: boolean } {
    // Idempotent retry (M5): a lost response must not create a second session.
    // Scoped to the caller; the same key with different parameters is a
    // client bug, not a retry.
    // P1-01: nobody else can reach a session until stage 4 rebuilds call
    // authorization — every new one is recorded private, whatever is asked
    // (so none turns public then).
    const visibility = "private" as const;
    const visibleTo: string[] = [];
    const replay = (old: Session) => {
      if (
        old.agent !== b.agent ||
        old.workspaceId !== b.workspaceId ||
        (old.workspaceMode || "shared") !== b.workspaceMode ||
        old.profileId !== b.profileId ||
        (old.task?.id || null) !== (b.task?.id || null) ||
        // Sessions created before visibility existed have nothing to compare.
        (old.initialVisibility &&
          JSON.stringify(old.initialVisibility) !==
            JSON.stringify({ visibility, visibleTo }))
      )
        throw new LocalizedError(409, "request_id_conflict", "server-app.session.requestIdConflict");
      return { ...old, duplicate: true };
    };
    const prior = b.requestId && store.sessionByRequest(u.id, b.requestId);
    if (prior) return replay(prior);
    const w = store.one("SELECT * FROM workspaces WHERE id=?", b.workspaceId),
      p = store.one(
        "SELECT * FROM profiles WHERE id=? AND owner_id=?",
        b.profileId,
        u.id,
      );
    if (!w || !p) throw new LocalizedError(400, "workspace_or_profile_unavailable", "server-app.session.workspaceOrProfile");
    usableNode(u, w.node_id);
    if (["read-only", "snapshot"].includes(b.workspaceMode)) {
      const caps = JSON.parse(
        store.one("SELECT capabilities FROM nodes WHERE id=?", w.node_id)
          ?.capabilities || "{}",
      );
      if (
        !(caps.workspaceAccess?.version >= 2) ||
        !caps.workspaceAccess?.readOnly
      )
        throw new LocalizedError(409, "read_only_unsupported", "server-app.session.readOnlyUnsupported");
    }
    const pf = JSON.parse(p.data);
    if (pf.agent !== b.agent || w.node_id !== pf.nodeId)
      throw new LocalizedError(400, "agent_profile_node_mismatch", "server-app.session.mismatch");
    // an identity in bypass only for a private AI, never a
    // resident (P1-01: every new session is private, see above).
    if (extra.kind === "resident")
      ctx.bypass?.checkOpen(pf, true);
    const now = Date.now(),
      s: Session = {
        id: id(),
        ownerId: u.id,
        // Untitled: a fallback on the first message, then a
        // generated summary after the first turn.
        title: b.title.trim() || untitledTitle(newSessionLang(ctx.opts.dataDir)),
        titleAuto: !b.title.trim(),
        ...(b.title.trim() ? { titleStage: "manual" as const } : {}),
        agent: b.agent,
        nodeId: w.node_id,
        workspaceId: w.id,
        workspaceMode: b.workspaceMode,
        profileId: p.id,
        nativeId: null,
        contextDelivered: false,
        task: b.task || null,
        status: "idle",
        archived: false,
        initialVisibility: { visibility, visibleTo },
        // P6-24: its prompts' language, for its whole life (ADR-159 §6).
        lang: newSessionLang(ctx.opts.dataDir),
        ...extra,
        createdAt: now,
        updatedAt: now,
      };
    const created = store.atomic(() => {
      const raced = b.requestId && store.sessionByRequest(u.id, b.requestId);
      if (raced) return raced;
      store.save(s, b.requestId);
      store.audit(u.id, "session.create", s.id);
      return null;
    });
    if (created) return replay(created);
    return { ...s, duplicate: false };
  }
  return { createSession };
}
export type SessionHelpers = ReturnType<typeof sessionHelpers>;
/**
 * Conversations (P1-00: moved from app.ts): list, create, read, page,
 * settings and archive, events, stop, delete, recovered evidence.
 */
export function registerSessionRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): void {
  const {
    store,
    user,
    session,
    forViewer,
    createSession,
    presence,
    stopWork,
    touched,
    purgeIfDeleted,
  } = ctx;
  // equal updatedAt by id (chat-store.ts sessionOrder).
  const sessionIdOrder = (a: Record<string, any>, b: Record<string, any>) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  const S = api.sessions;
  serve(app, S.list, async (req) => {
    const u = user(req),
      q = S.list.query.parse(req.query);
    // fb3 F3: a task's sessions are those bound to it (task.id) or whose
    // messages carried it in their context (relatedTasks).
    return (
      (
        q.taskId
          ? store.all(
              `SELECT data FROM sessions WHERE owner_id=? AND (
               json_extract(data,'$.task.id')=? OR EXISTS(
                 SELECT 1 FROM json_each(data,'$.relatedTasks') r
                 WHERE json_extract(r.value,'$.id')=?) OR EXISTS(
                 SELECT 1 FROM json_each(data,'$.resident.tasks') t
                 WHERE json_extract(t.value,'$.id')=?))`,
              u.id,
              q.taskId,
              q.taskId,
              q.taskId,
            )
          : store.all("SELECT data FROM sessions WHERE owner_id=?", u.id)
      )
        .map((r: any) => sessionListView(r.data))
        // 「只问」 sidecars are internal (hidden everywhere).
        // P4-07: so are a resident agent's dedicated sessions (its show lists them).
        .filter((s) => !s.deleting && !s.sidecar && !s.residentOf)
        .sort((a, b) => b.updatedAt - a.updatedAt || sessionIdOrder(a, b))
    );
  });
  serve(app, S.create, async (req) =>
    createSession(user(req), S.create.body.parse(req.body)),
  );
  /**
   * whether 「同时撤销文件」 is offered for the session's agent on
   * its node (Claude natively, Codex by Daisy's checkpoints); P4-11: with
   * every other §5.5 capability (`features`), from the node's report
   * (parsed once per report, sessions/features.ts).
   */
  const featuresOf = (s: Session) => {
    const features = sessionFeatures(store, s);
    return { rewindFiles: features.rewindFiles, features };
  };
  /** a visible page size — default 20, clamped to 1…100. */
  const pageLimit = (v: unknown) => {
    const n = Number(v);
    return v === undefined || v === "" || !Number.isFinite(n)
      ? VISIBLE_PAGE_DEFAULT
      : Math.min(VISIBLE_PAGE_MAX, Math.max(1, Math.trunc(n)));
  };
  const Q = S.show.query.shape;
  serve(app, S.show, async (req) => {
    const s = session(req, (req.params as any).id),
      q = req.query as any;
    // ?tail=N: newest N items only (prefetch); `partial` marks the cut.
    const tail = Q.tail.parse(q.tail);
    // ?since=<cursor>[&from=<oldest held item>]: only what changed
    // after the client's version; a tail / full snapshot when a delta can't.
    const since = Q.since.parse(q.since);
    // A string of 1–400 characters, else ignored.
    const from = Q.from.parse(q.from);
    // a resident's conversation view — the newest `messageLimit`
    // visible items, never a raw delta. Other sessions ignore `view`.
    if (Q.view.parse(q.view) === "conversation" && s.kind === "resident")
      return {
        ...forViewer(
          req,
          s.ownerId,
          store.conversationSnapshot(s.id, pageLimit(q.messageLimit)),
        ),
        node: presence(s.nodeId, requestT(req)),
        ...featuresOf(s),
      };
    let snap =
      (since !== undefined && store.delta(s.id, since, from)) ||
      store.snapshot(s.id, tail);
    // The client holds a version this log never reached (a restore): say
    // so, or it would keep its window as the newer one.
    if (since !== undefined && !snap.delta && since > snap.cursor)
      snap = { ...snap, reset: true };
    // an admin reading a member's conversation sees
    // 「仅会话所有者可见」 instead of the owner's quota.
    return {
      ...forViewer(req, s.ownerId, snap),
      node: presence(s.nodeId, requestT(req)),
      ...featuresOf(s),
    };
  });
  // Older items of a held window, owner-only like the snapshot.
  const I = S.items.query.shape;
  serve(app, S.items, async (req) => {
    const s = session(req, (req.params as any).id),
      q = req.query as any;
    const before = I.before.parse(q.before);
    if (I.view.parse(q.view) === "conversation" && s.kind === "resident") {
      // the same visible view, paged back (limit ≤ 100).
      const page = store.visibleItems(s.id, pageLimit(q.limit), before);
      if (!page) throw new LocalizedError(409, "item_gone", "server-app.session.itemGone");
      return forViewer(req, s.ownerId, {
        ...page,
        view: "conversation" as const,
        before: page.items[0]?.id ?? null,
        ...(page.more ? { partial: true } : {}),
      });
    }
    const limit = I.limit.parse(q.limit ?? 200);
    const page = store.olderItems(s.id, before, limit);
    if (!page) throw new LocalizedError(409, "item_gone", "server-app.session.itemGone");
    return forViewer(req, s.ownerId, page);
  });
  serve(app, S.update, async (req) => {
    const sid = session(req, (req.params as any).id).id,
      b = S.update.body.parse(req.body);
    if (b.settings) {
      // P4-11 (§5.5): a model / effort of its own only when the AI
      // declares switching it ("" = back to the identity's is always fine).
      const s0 = store.session(sid)!;
      requireFeatures(
        store,
        s0,
        ...(b.settings.model ? (["model"] as const) : []),
        ...(b.settings.reasoningEffort ? (["effort"] as const) : []),
      );
      // ultra / Fast are Codex's, and the model's own (catalog).
      const s = store.session(sid)!,
        next = { ...s.settings, ...b.settings },
        profile = store.one(
          "SELECT data FROM profiles WHERE id=?",
          s.profileId,
        ),
        why = settingsError(
          s.agent,
          {
            model:
              next.model || (profile ? JSON.parse(profile.data).model : ""),
            reasoningEffort: next.reasoningEffort,
            serviceTier: next.serviceTier,
          },
          s.commandCatalog?.models,
          requestT(req),
        );
      // Said in the request's language (contracts' settingsError takes the translator).
      if (why) throw new HttpError(400, why, "settings_invalid");
    }
    // Re-read inside the transaction: a concurrent message may have just
    // merged new related tasks.
    const saved = store.atomic(() => {
      const s = store.session(sid)!;
      if (b.title !== undefined) {
        s.title = b.title;
        s.titleAuto = false; // a user's title is never replaced
        s.titleStage = "manual";
      }
      if (b.archived !== undefined) s.archived = b.archived;
      // Archiving closes the conversation: nothing of it keeps running.
      if (b.archived) {
        stopWork(s);
        ctx.live.stop(s.id);
      }
      if (b.settings) {
        const next = { ...s.settings, ...b.settings };
        for (const k of ["model", "reasoningEffort", "serviceTier"] as const)
          if (!next[k]) delete next[k];
        s.settings = next;
      }
      if (b.relatedTasks) {
        const keep = new Set(b.relatedTasks);
        s.relatedTasks = (s.relatedTasks || []).filter((t) => keep.has(t.id));
      }
      // archived, or 「只问」 turned off — its open sidecars close
      // (a running sidecar turn still finishes and answers).
      if (b.archived || b.settings?.askSidecar === false)
        ctx.sidecars.closeAll(s.id);
      s.updatedAt = Date.now();
      store.save(s);
      return s;
    });
    // an archived conversation's Daisy timers and background
    // items end too (after the save above: it rewrites schedulerPending).
    // (P1-01: residents are off until stage 4; a resident is no different.)
    // The end reason reaches the AI in tool results: the session's language (P6-24).
    if (b.archived) ctx.scheduler.cancelAll(saved.id, promptSessionT(saved)("server-app.session.archived"));
    if (b.archived !== undefined && saved.kind === "resident")
      store.audit(
        user(req).id,
        b.archived ? "resident.archive" : "resident.restore",
        saved.id,
      );
    touched(saved.id);
    // A wake that waited for it to be restored runs now.
    if (b.archived === false) ctx.wakes.deliver();
    return forViewer(req, saved.ownerId, store.session(saved.id) ?? saved);
  });
  serve(app, S.events, async (req) => {
    const s = session(req, (req.params as any).id),
      after = S.events.query.shape.after.parse((req.query as any).after || 0);
    const ev = store.events(s.id, after);
    return {
      events: forViewer(req, s.ownerId, ev),
      hasMore: ev.length === 500,
    };
  });
  serve(app, S.cancel, async (req) => {
    stopWork(session(req, (req.params as any).id));
    return { ok: true };
  });
  /**
   * Delete a conversation: stop its work for real (the runner
   * kills the agent process group), hide it at once, purge every row as
   * soon as no turn of it runs. `stopping: true` = a turn was still running
   * and is being killed; the rows go when it has ended (or its lease lapses).
   */
  serve(app, S.delete, async (req) => {
    const s = session(req, (req.params as any).id);
    // stopped callback wakes of a deleted one are gone.
    const stopping = stopWork({ ...s, deleting: true });
    ctx.live.stop(s.id);
    // everything it had scheduled ends now (held timers too); its
    // Runner stops background work on its next report (session deleting).
    ctx.scheduler.cancelAll(s.id, promptSessionT(s)("server-app.session.deleted"));
    // P4-03 review L-4: as an agent it is gone — its grants, range and
    // call cards go, calls to it stop.
    ctx.access.invoke.forgetAgent(s.id);
    store.atomic(() => {
      const cur = store.session(s.id)!;
      cur.deleting = true;
      cur.archived = true;
      cur.updatedAt = Date.now();
      store.save(cur);
    });
    store.audit(user(req).id, "session.delete", s.id);
    purgeIfDeleted(s.id);
    return { ok: true, stopping, deleted: !store.session(s.id) };
  });
  serve(app, S.recoveryEvents, async (req: any) => {
    const s = session(req, req.params.id);
    if (
      !store.one(
        "SELECT 1 FROM job_recoveries WHERE job_id=? AND session_id=?",
        req.params.jid,
        s.id,
      )
    )
      throw new LocalizedError(404, "recovery_not_found", "server-app.session.recoveryNotFound");
    const after = S.recoveryEvents.query.shape.after.parse(req.query.after);
    const rows = store.all(
      "SELECT seq,data FROM job_recovery_events WHERE job_id=? AND seq>? ORDER BY seq LIMIT 201",
      req.params.jid,
      after,
    );
    const page = rows.slice(0, 200);
    return {
      items: forViewer(
        req,
        s.ownerId,
        page.map((r) => ({ seq: r.seq, ...JSON.parse(r.data) })),
      ),
      nextCursor: rows.length > 200 ? page.at(-1)!.seq : null,
    };
  });
  serve(app, S.recoveries, async (req: any) => {
    const s = session(req, req.params.id);
    const list = store
      .all(
        "SELECT job_id id,data,created FROM job_recoveries WHERE session_id=? ORDER BY created DESC LIMIT 50",
        s.id,
      )
      .map((r) => ({
        ...r,
        data: {
          ...JSON.parse(r.data),
          events: store
            .all(
              "SELECT data FROM job_recovery_events WHERE job_id=? ORDER BY seq DESC LIMIT 200",
              r.id,
            )
            .reverse()
            .map((e) => JSON.parse(e.data)),
        },
      }));
    return forViewer(req, s.ownerId, list);
  });
}
