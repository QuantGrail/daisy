import {
  autoCompactSupport,
  type ContextThreshold,
  type LiveState,
  type Session,
  type User,
} from "../../../contracts/src/index.ts";
import type { Store } from "../store/index.ts";
import { api } from "../../../contracts/src/api/index.ts";
import { serve } from "../app/serve.ts";
import { LocalizedError } from "../app/errors.ts";
import type { MessageKey } from "../../../contracts/src/i18n.ts";
import { ownerT } from "../platform/language.ts";
/**
 * Auto-compact threshold per identity:
 * what its online processes run with, and 立即重启. The value itself is
 * `PATCH /api/profiles/:id {autoCompactTokens}`; Runners learn it from the
 * live report's `apply` and restart each process once idle.
 */
/**
 * This session's auto-compact threshold: its own
 * (a resident's), else the identity's. P1-01: moved out of resident.ts.
 */
export function sessionAutoCompact(
  s: Pick<Session, "resident"> | undefined,
  identity: number | null,
): number | null {
  const own = s?.resident?.autoCompactTokens;
  return typeof own === "number" && own > 0 ? own : identity;
}

export interface AutoCompactSessionState {
  sessionId: string;
  title: string;
  /** applied: runs the identity's value; waiting: restarts once idle; unknown: an older Runner. */
  state: "applied" | "waiting" | "restarting" | "unknown";
  /** The value the process runs with (null = CLI default). */
  tokens: number | null;
  /** 立即重启 was asked and not yet carried out. */
  restartNow: boolean;
  /** What 立即重启 would interrupt, one phrase each (empty = nothing). */
  interrupts: string[];
}
export interface AutoCompactStatus {
  profileId: string;
  agent: Session["agent"];
  /** The identity's setting (null = the CLI default). */
  tokens: number | null;
  support:
    | { configurable: true; range: [number, number] }
    | { configurable: false; reason: string };
  /** The newest trigger point a process of this identity reported. */
  reported: (ContextThreshold & { at: number; sessionId: string }) | null;
  sessions: AutoCompactSessionState[];
}
const fail = (statusCode: number, code: string, key: MessageKey): never => {
  throw new LocalizedError(statusCode, code, key);
};
/** What restarting this process now would stop. */
export function interruptsOf(live: LiveState): string[] {
  const out: string[] = [];
  const t = ownerT();
  if (live.busy) out.push(t("server-sessions.interrupts.turn"));
  const pending = live.pending || [];
  const tasks = pending.filter((t) => t.kind === "task"),
    timers = pending.filter((t) => t.kind !== "task");
  const names = (list: typeof pending) =>
    t(list.length > 3 ? "server-sessions.interrupts.namesMore" : "server-sessions.interrupts.names", {
      names: list
        .slice(0, 3)
        .map((x) => t("server-sessions.interrupts.name", { name: x.label.slice(0, 40) }))
        .join(t("server-sessions.interrupts.separator")),
    });
  if (tasks.length) out.push(t("server-sessions.interrupts.tasks", { n: tasks.length, names: names(tasks) }));
  if (timers.length) out.push(t("server-sessions.interrupts.timers", { n: timers.length, names: names(timers) }));
  return out;
}
export function autoCompactStatus(store: Store, row: any): AutoCompactStatus {
  const p = JSON.parse(row.data);
  const node = store.one(
    "SELECT capabilities FROM nodes WHERE id=?",
    row.node_id,
  );
  const tokens =
    typeof p.autoCompactTokens === "number" && p.autoCompactTokens > 0
      ? p.autoCompactTokens
      : null;
  const support = autoCompactSupport(
    JSON.parse(node?.capabilities || "{}"),
    p.agent,
    ownerT(),
  );
  const sessions: AutoCompactSessionState[] = store
    .all(
      // Only the identity owner's own conversations (review N5: an identity
      // an admin reassigned keeps sessions of its previous owner).
      `SELECT l.session_id, l.data FROM live_sessions l JOIN sessions s ON s.id=l.session_id
       WHERE json_extract(s.data,'$.profileId')=? AND s.owner_id=? ORDER BY l.updated DESC LIMIT 50`,
      row.id,
      row.owner_id,
    )
    .map((r) => {
      const live = JSON.parse(r.data) as LiveState,
        s = store.session(r.session_id),
        ac = live.autoCompact;
      return {
        sessionId: r.session_id,
        title: s?.title || ownerT()("server-sessions.newConversation"),
        // A device that cannot apply it (old Runner / CLI) never restarts.
        state:
          !ac || !support.configurable
            ? "unknown"
            : ac.restarting
              ? "restarting"
              : // a resident runs its own threshold.
                ac.tokens === sessionAutoCompact(s, tokens)
                ? "applied"
                : "waiting",
        tokens: ac ? ac.tokens : null,
        restartNow: !!store.one(
          "SELECT 1 FROM live_restarts WHERE session_id=?",
          r.session_id,
        ),
        interrupts: interruptsOf(live),
      } as AutoCompactSessionState;
    });
  const newest = store.one(
    `SELECT id, json_extract(data,'$.context') AS c FROM sessions
     WHERE owner_id=? AND json_extract(data,'$.profileId')=? AND json_extract(data,'$.context.updatedAt') IS NOT NULL
     ORDER BY json_extract(data,'$.context.updatedAt') DESC LIMIT 1`,
    row.owner_id,
    row.id,
  );
  const c = newest?.c ? JSON.parse(newest.c) : null;
  return {
    profileId: row.id,
    agent: p.agent,
    tokens,
    support,
    reported: c?.threshold
      ? { ...c.threshold, at: c.updatedAt, sessionId: newest.id }
      : null,
    sessions,
  };
}
export function autoCompactRoutes(
  app: any,
  store: Store,
  o: {
    user: (req: any) => User;
    /** The identity's node should report its live sessions now. */
    nudge: (nodeId: string) => void;
  },
) {
  /** Owner only — admins included (as the identity's secrets). */
  const owned = (req: any) => {
    const u = o.user(req),
      row = store.one(
        "SELECT * FROM profiles WHERE id=? AND owner_id=?",
        req.params.id,
        u.id,
      );
    if (!row) fail(404, "profile_not_found", "server-sessions.error.profileNotFound");
    return { u, row };
  };
  serve(app, api.profiles.autoCompact, async (req: any) =>
    autoCompactStatus(store, owned(req).row),
  );
  /**
   * 立即重启: every online process of this identity not yet on
   * its value restarts now, interrupting what it is doing; the UI confirms
   * first with what will be interrupted (`interrupts`).
   */
  serve(app, api.profiles.autoCompactRestart, async (req: any) => {
    const { u, row } = owned(req);
    const status = autoCompactStatus(store, row);
    const now = Date.now();
    const targets = status.sessions.filter((x) => x.state === "waiting");
    for (const t of targets)
      store.run(
        `INSERT INTO live_restarts(session_id,node_id,profile_id,requested,user_id) VALUES(?,?,?,?,?)
         ON CONFLICT(session_id) DO UPDATE SET requested=excluded.requested,user_id=excluded.user_id`,
        t.sessionId,
        row.node_id,
        row.id,
        now,
        u.id,
      );
    if (targets.length) {
      store.audit(u.id, "profile.auto-compact.restart", row.id);
      o.nudge(row.node_id);
    }
    return autoCompactStatus(store, row);
  });
}
