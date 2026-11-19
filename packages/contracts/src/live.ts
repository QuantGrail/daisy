// An online Agent process and its background work (P1-00: moved from index.ts).
/** Something that will wake the Agent up later. */
export interface LiveTimer {
  id: string;
  /** wakeup: ScheduleWakeup · cron: CronCreate · task: background task / subagent / Monitor. */
  kind: "wakeup" | "cron" | "task";
  label: string;
  /** When it fires (ms), if known. */
  at?: number;
  recurring?: boolean;
  /**
   * task: what kind of background work — Claude Code's task_type:
   * local_bash (background command), monitor_mcp / monitor_ws (Monitor),
   * local_agent (subagent), remote_agent, local_workflow, dream…
   */
  type?: string;
  /** Background command / Monitor: the command line. */
  command?: string;
  /** Subagent: its agent type and the prompt it was given. */
  subagent?: string;
  prompt?: string;
  /** When it started (ms). */
  since?: number;
  /**
   * "scheduler" = Daisy's scheduler (kept by the control plane,
   * survives restarts, wakes an offline session); absent = the Agent's own.
   * ADR-152: written "harbor" before — read through `isSchedulerItem`.
   */
  source?: "scheduler";
  /**
   * the Agent's own task the person can stop alone (「停止」,
   * `POST /api/sessions/:id/background/:taskId/stop`). Set by the control
   * plane from the node's `background.stop` capability; Daisy's items
   * (`source: "scheduler"`) are always stoppable by the owner.
   */
  stoppable?: boolean;
  /** a stop was asked and has not landed yet. */
  stopping?: boolean;
}
/**
 * What one background task is doing right now. Changes all the
 * time, so it is not part of `LiveState` / the event log: the conversation
 * reads it on demand (`GET /api/sessions/:id/live/activity`).
 */
export interface LiveActivity {
  /** The `LiveTimer.id` it belongs to. */
  id: string;
  /** Subagent: latest progress summary, last tool, totals. */
  summary?: string;
  lastTool?: string;
  tokens?: number;
  toolUses?: number;
  /** Background command / Monitor: the end of its output (plain text). */
  output?: string;
  /** Size of the whole output (bytes); `output` is only its end. */
  outputBytes?: number;
}
export interface LiveState {
  online: boolean;
  /** the identity the process was started with (newer Runners). */
  profileId?: string;
  /** Process start (ms). */
  since?: number;
  /** Last turn / output (ms); idle-offline counts from here. */
  lastActivity?: number;
  /** A turn is running in the process. */
  busy?: boolean;
  /** Pending timers and background work: while any exist it stays online. */
  pending?: LiveTimer[];
  /** Why it went offline (idle, restart, stopped, exited…). */
  reason?: string;
  /** The user asked it to go offline; the runner is closing it. */
  stopping?: boolean;
  /**
   * Auto-compact threshold of this process: `tokens` it was
   * started with (null = the CLI default), `want` a new identity value
   * waiting for the process to go idle, `restarting` while it restarts.
   * Absent: an older Runner, or an Agent without the setting.
   */
  autoCompact?: {
    tokens: number | null;
    want?: number | null;
    restarting?: boolean;
  };
  at: number;
}

/**
 * ADR-152: Daisy's scheduler items in the
 * 「后台」 list. Their old spelling — `source: "harbor"`, id
 * `harbor:<scheduleId>`, type `harbor_bash` / `harbor_monitor`, the
 * session field `harborPending` — is still in stored session records and
 * comes from an older server; every reader takes it as the new one,
 * writers only write the new one.
 */
export const SCHEDULER_SOURCE = "scheduler" as const;
/** The id of a scheduler item: this prefix and the schedule's id. */
export const SCHEDULER_ID_PREFIX = "scheduler:";
/** The `type` of a scheduler background command / Monitor. */
export const SCHEDULER_TASK_TYPES = {
  bash: "scheduler_bash",
  monitor: "scheduler_monitor",
} as const;
const LEGACY_SOURCE = "harbor";
const LEGACY_ID_PREFIX = "harbor:";
const LEGACY_TASK_TYPES: Record<string, string> = {
  harbor_bash: SCHEDULER_TASK_TYPES.bash,
  harbor_monitor: SCHEDULER_TASK_TYPES.monitor,
};
/** Daisy's scheduler keeps it (new or old spelling). */
export const isSchedulerItem = (t: { source?: string } | null | undefined) =>
  t?.source === SCHEDULER_SOURCE || t?.source === LEGACY_SOURCE;
/** The schedule id of a scheduler item id (`scheduler:<id>` or the old `harbor:<id>`); null: not one. */
export function schedulerItemId(id: string): string | null {
  for (const p of [SCHEDULER_ID_PREFIX, LEGACY_ID_PREFIX])
    if (id.startsWith(p) && id.length > p.length) return id.slice(p.length);
  return null;
}
/** One 「后台」 item in the new spelling (the same object when it already is). */
export function normalizeLiveTimer<T extends LiveTimer>(t: T): T {
  const old = (t as { source?: string }).source === LEGACY_SOURCE;
  const type = t.type && LEGACY_TASK_TYPES[t.type];
  const oldId = old && t.id.startsWith(LEGACY_ID_PREFIX);
  if (!old && !type) return t;
  return {
    ...t,
    ...(old ? { source: SCHEDULER_SOURCE } : {}),
    ...(oldId
      ? { id: SCHEDULER_ID_PREFIX + t.id.slice(LEGACY_ID_PREFIX.length) }
      : {}),
    ...(type ? { type } : {}),
  };
}
/** A session (record or snapshot) as written by any version. */
type PendingHolder = {
  schedulerPending?: LiveTimer[];
  /** ADR-152: the field's name before. */
  harborPending?: LiveTimer[];
};
/** The session's scheduler items, whichever name and spelling it has them under. */
export function schedulerPendingOf(
  s: PendingHolder | null | undefined,
): LiveTimer[] {
  const list = s?.schedulerPending ?? s?.harborPending;
  return Array.isArray(list) ? list.map(normalizeLiveTimer) : [];
}
/**
 * A stored session record in the new spelling: `harborPending` becomes
 * `schedulerPending` (its items too). The same object when nothing was
 * old; otherwise a copy.
 */
export function normalizeSessionRecord<T extends object>(s: T): T {
  const h = s as T & PendingHolder;
  if (
    !("harborPending" in h) &&
    !h.schedulerPending?.some((t) => normalizeLiveTimer(t) !== t)
  )
    return s;
  const { harborPending: _old, ...rest } = h;
  const list = schedulerPendingOf(h);
  return { ...rest, ...(list.length ? { schedulerPending: list } : {}) } as T;
}
/**
 * P6-26 (ADR-142 §5, P5N-6): how the server ends a live socket (`/api/live`).
 * - `credential` (1008): the credential is refused or ended (expired, logged
 *   out, an issuer token's `exp`): renew it (`credentials({refresh: true})`)
 *   and subscribe again.
 * - `deviceRevoked` (4401): this paired device was revoked (or every device,
 *   by a PIN reset) — at once, no change in the conversation needed. Its
 *   session and credential are void: the client asks its credentials now (no
 *   timer, so a throttled background page reacts too) and a paired device's
 *   page goes back to its login screen. An older client treats it as a
 *   dropped socket; its next subscribe is refused with 1008.
 * - `restart` (1012): the server is being replaced: reconnect soon.
 * - `slow` (1013): the client did not read its frames.
 */
export const LIVE_CLOSE = {
  credential: 1008,
  deviceRevoked: 4401,
  restart: 1012,
  slow: 1013,
} as const;
