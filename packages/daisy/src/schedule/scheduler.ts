import { daisyEnv } from "../../../contracts/src/env.ts";
import type { RunnerPort } from "../app/runner-port.ts";
import { serve } from "../app/serve.ts";
import { api } from "../../../contracts/src/api/index.ts";
import { z } from "zod";
import type {
  Event,
  LiveTimer,
  Session,
  DaisySchedule,
  ScheduleStatus,
} from "../../../contracts/src/index.ts";
import {
  SCHEDULE_LIMITS,
  ScheduleCreateSchema,
  ScheduleEventSchema,
  cronGap,
  nextCron,
  parseCron,
  residentHeld,
  type ScheduleCreate,
} from "../../../contracts/src/scheduler.ts";
import {
  cronText,
  localTimeZone,
} from "../../../contracts/src/scheduler.ts";
import {
  SCHEDULER_ID_PREFIX,
  SCHEDULER_SOURCE,
  SCHEDULER_TASK_TYPES,
} from "../../../contracts/src/live.ts";
import { id, type Store } from "../store/index.ts";
import { clean } from "../prompts/source-prompt.ts";
/** Review: carried bodies fenced, so output cannot forge a header. */
const fence = (body: string) =>
  `<external_message>\n${clean(body)}\n</external_message>`;
import type { notificationWriter } from "../sessions/notifications.ts";
import { traceForNewTurn } from "../observe/trace.ts";
import { log } from "../observe/log.ts";
import { callbackJob } from "./callback-jobs.ts";
import type { MessageKey } from "../../../contracts/src/i18n.ts";
import {
  LEGACY_PROMPT_LANG,
  promptForms,
  promptT,
  sessionT,
  type PromptT,
} from "../../../contracts/src/prompt-i18n.ts";
import { CronError } from "../../../contracts/src/scheduler.ts";
import { requestT } from "../app/language.ts";
import { HttpError } from "../app/errors.ts";
// P6-24: the language packs, loaded for the prompt builders.
import "../prompts/lang.ts";
// P6-24: an HttpError, so the owner's answer carries its stable `code` (`cron_invalid` …).
const fail = (statusCode: number, message: string, code?: string): never => {
  throw new HttpError(statusCode, message, code);
};
/**
 * P6-24: a refusal said in one language — the session's for the Agent's
 * tool calls (Runner routes), the request's for its owner (owner routes).
 */
type Refuse = (
  statusCode: number,
  key: MessageKey,
  params?: Record<string, string | number>,
  code?: string,
) => never;
const refuseIn =
  (t: PromptT | ReturnType<typeof requestT>): Refuse =>
  (statusCode, key, params, code) =>
    fail(statusCode, t.dynamic(key, params), code);
/** A cron a person or the Agent wrote, refused in `t`'s language. */
const cronWhy = (t: { dynamic(k: string, p?: Record<string, unknown>): string }, e: any) =>
  e instanceof CronError ? t.dynamic(e.key, e.params) : String(e?.message || e);
const DAY = 86400_000;
/** A running row the Runner does not list is lost only once it is this old (create / spawn race). */
const LOST_GRACE_MS = 15_000;
/** Ended rows kept per session for the list (older ones are deleted). */
const KEEP_ENDED = 30;
/** Fire text a queued wake may grow to by coalescing. */
const COALESCE_MAX = 60_000;
/** undelivered report text kept per row (the oldest part is cut in the middle). */
const REPORT_MAX = 20_000;
/** kept reports one turn carries at most, and each one at most (review H1). */
const CARRY_MAX = 30_000;
const PER_REPORT = 8_000;
/** The first words of a wake made only to deliver kept reports (the session's language). */
const REDELIVER_HEAD = "prompt-schedule.head.redeliver" as const;
/** the first words of a wake made only to deliver kept callbacks (a plugin's, hook 2). */
const CALLBACK_HEAD = "prompt-schedule.head.callback" as const;
/**
 * A 补送 wake's text, in any language's words (P6-24: each session writes
 * its own) or as written before ADR-154 (`【Harbor 补送…】`) — a job queued
 * then still says so.
 */
export const isRedeliveryWake = (text: unknown) => {
  const x = String(text || "");
  return (
    /^【(?:Daisy|Harbor) 补送(?:后台回报|外部回调)】/.test(x) ||
    [...promptForms(REDELIVER_HEAD), ...promptForms(CALLBACK_HEAD)].some((h) => x.startsWith(h))
  );
};
/** the sweep's own wake for kept callbacks (`schedule:kept-callbacks:<job>`). */
const KEPT_WAKE = "kept-callbacks";
/** kept callbacks per session, and how old one may be. */
const KEPT_MAX = 200;
const KEPT_STALE_MS = 7 * 86400_000;
/** A row's status in words: `prompt-schedule.status.<status>`. */
const statusWords = (t: PromptT, status: string) =>
  t.has(`prompt-schedule.status.${status}`) ? t.dynamic(`prompt-schedule.status.${status}`) : status;
/** next delivery attempt after a full queue / a used-up daily budget. */
const RETRY_FULL_MS = 10_000;
const RETRY_BUDGET_MS = 60_000;
/** the scheduler's resource limits (control plane; env or createApp). */
export interface SchedulerLimits {
  /** Running background commands + monitors per session. */
  sessionBackground: number;
  /** … per node (Runner), all its sessions together. */
  nodeBackground: number;
  /** Shortest gap between two monitor wakes of one session. */
  monitorMinIntervalMs: number;
}
const positive = (v: string | undefined) => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) && n > 0
    ? Math.floor(n)
    : undefined;
};
/**
 * DAISY_BACKGROUND_PER_SESSION / DAISY_BACKGROUND_PER_NODE /
 * DAISY_MONITOR_MIN_INTERVAL_S; unset or invalid → the default.
 */
export function schedulerLimits(
  over: Partial<SchedulerLimits> = {},
  env: Record<string, string | undefined> = process.env,
): SchedulerLimits {
  const interval = positive(daisyEnv("DAISY_MONITOR_MIN_INTERVAL_S", env));
  return {
    sessionBackground:
      over.sessionBackground ??
      positive(daisyEnv("DAISY_BACKGROUND_PER_SESSION", env)) ??
      SCHEDULE_LIMITS.background,
    nodeBackground:
      over.nodeBackground ??
      positive(daisyEnv("DAISY_BACKGROUND_PER_NODE", env)) ??
      SCHEDULE_LIMITS.nodeBackground,
    monitorMinIntervalMs:
      over.monitorMinIntervalMs ??
      (interval !== undefined ? interval * 1000 : undefined) ??
      SCHEDULE_LIMITS.monitorMinIntervalMs,
  };
}
const FENCE_OPEN = "<external_message>",
  FENCE_CLOSE = "</external_message>";
/** A cut at `at` not through a fence tag: before the tag (`back`) or after it. */
const offTag = (text: string, at: number, back: boolean) => {
  for (const tag of [FENCE_OPEN, FENCE_CLOSE]) {
    const i = text.indexOf(tag, Math.max(0, at - tag.length + 1));
    if (i >= 0 && i < at) return back ? i : i + tag.length;
  }
  return at;
};
/**
 * Head and end of a long text, the middle cut (coalesced wakes, kept
 * reports). A text may carry <external_message> fences of its own (a
 * plugin callback's 机审意见): the cut never goes through a tag,
 * a fence the head leaves open is closed before the 「中间省略」 line and one
 * the end starts inside is opened again after it — every fence keeps both
 * ends and what was fenced stays fenced.
 */
export const clip = (text: string, max: number, t: PromptT = promptT(LEGACY_PROMPT_LANG)) => {
  if (text.length <= max) return text;
  // Never split a surrogate pair (review L3).
  let head = Math.min(2000, Math.floor(max / 3)),
    tail = text.length - Math.max(0, max - head - 100);
  if (/[\ud800-\udbff]/.test(text[head - 1] || "")) head--;
  if (/[\udc00-\udfff]/.test(text[tail] || "")) tail++;
  head = offTag(text, head, true);
  tail = offTag(text, tail, false);
  const a = text.slice(0, head),
    b = text.slice(tail);
  const open = a.lastIndexOf(FENCE_OPEN) > a.lastIndexOf(FENCE_CLOSE),
    bo = b.indexOf(FENCE_OPEN),
    bc = b.indexOf(FENCE_CLOSE),
    reopen = bc >= 0 && (bo < 0 || bc < bo);
  return (
    a +
    (open ? `\n${FENCE_CLOSE}` : "") +
    t("prompt-schedule.clip") +
    (reopen ? `${FENCE_OPEN}\n` : "") +
    b
  );
};
/** results held per paused resident, and how old one may be. */
const HELD_MAX = 200;
const HELD_STALE_MS = 7 * 86400_000;
const HELD_DROPPED = "held-dropped";
/** Why a wake could not be delivered then: `prompt-schedule.reason.<reason>`. */
const reasonWords = (t: PromptT, reason: string) =>
  t.has(`prompt-schedule.reason.${reason}`)
    ? t.dynamic(`prompt-schedule.reason.${reason}`)
    : t("prompt-schedule.reason.unknown");
export interface SchedulerDeps {
  user: (req: any) => { id: string };
  /** Owner-checked session (404 / 403 otherwise). */
  session: (req: any, sid: string) => Session;
  claimingNode: (req: any) => { id: string };
  /** P1-02: the in-process Runner's calls (were /api/runner/*). */
  runner: RunnerPort;
  /** Tell the open views about events already appended. */
  broadcast: (ev: Event | null) => unknown;
  /** Session record changed without an event. */
  touched: (sid: string) => void;
  /** Leader only: firing is background work. */
  leading: () => boolean;
  /** The notification writer. */
  notifications: ReturnType<typeof notificationWriter>;
  /** Limits (default: `schedulerLimits()`, i.e. env or the defaults). */
  limits?: SchedulerLimits;
  /** P6-24: the data directory (the owner's language for owner-route refusals). */
  dataDir?: string;
}
/**
 * Daisy's scheduler, control-plane side: one row per timer /
 * background command / monitor in `agent_schedules`. Timers fire here (a
 * leader sweep each second) by queueing a turn for the session — origin
 * "schedule" — so they survive Runner restarts and wake offline sessions
 * (the Runner starts the Agent and resumes). Background work runs on the
 * session's Runner, which reports output / exit; a Runner restart is
 * reported as `lost` (never re-run).
 */
export function schedulerRoutes(app: any, store: Store, deps: SchedulerDeps) {
  const limits = deps.limits ?? schedulerLimits();
  /** P6-24: a session's own language (what its Agent reads). */
  const tOf = (sid: string): PromptT => sessionT(store.session(sid));
  /** Refusals to the Agent (its session's language) and to its owner (the request's). */
  const agentRefuse = (s: Session | null | undefined): Refuse => refuseIn(sessionT(s));
  const ownerRefuse = (req: any): Refuse => refuseIn(requestT(req, deps.dataDir));
  const view = (r: any): DaisySchedule => {
    const d = JSON.parse(r.data);
    if (d.undelivered) {
      // The kept text is the Agent's, not the list's.
      const { text: _text, ...u } = d.undelivered;
      d.undelivered = { ...u, retryAt: r.report_at ?? null };
    }
    return view0(r, d);
  };
  const view0 = (r: any, { creatorJob: _c, ...d }: any): DaisySchedule => ({
    ...d,
    id: r.id,
    sessionId: r.session_id,
    kind: r.kind,
    status: r.status,
    nextAt: r.next_at ?? null,
    createdAt: r.created,
    updatedAt: r.updated,
  });
  const openRows = (sid: string) =>
    store.all(
      "SELECT * FROM agent_schedules WHERE session_id=? AND status IN ('active','running') ORDER BY created",
      sid,
    );
  /** Open rows, ended rows with a report not delivered yet, then the latest ended. */
  const list = (sid: string, ended = 20): DaisySchedule[] => [
    ...openRows(sid).map(view),
    // a paused resident's held timers, then the ended ones.
    ...store
      .all(
        "SELECT * FROM agent_schedules WHERE session_id=? AND status='paused' ORDER BY created",
        sid,
      )
      .map(view),
    ...store
      .all(
        "SELECT * FROM agent_schedules WHERE session_id=? AND status NOT IN ('active','running','paused') ORDER BY report_at IS NULL, updated DESC LIMIT ?",
        sid,
        ended,
      )
      .map(view),
  ];
  /** The session's open items as 「后台」 entries. */
  const pendingOf = (sid: string): LiveTimer[] =>
    openRows(sid).map((r) => {
      const s = view(r),
        base = {
          id: SCHEDULER_ID_PREFIX + s.id,
          label: s.label,
          source: SCHEDULER_SOURCE,
          since: s.createdAt,
        };
      if (s.kind === "wakeup")
        return {
          ...base,
          kind: "wakeup",
          ...(s.nextAt ? { at: s.nextAt } : {}),
        };
      if (s.kind === "cron")
        return {
          ...base,
          kind: "cron",
          recurring: !!s.recurring,
          ...(s.nextAt ? { at: s.nextAt } : {}),
          ...(s.prompt ? { prompt: s.prompt.slice(0, 600) } : {}),
        };
      return {
        ...base,
        kind: "task",
        type:
          s.kind === "bash"
            ? SCHEDULER_TASK_TYPES.bash
            : SCHEDULER_TASK_TYPES.monitor,
        command: (s.command || "").slice(0, 2000),
      };
    });
  /**
   * Write `session.schedulerPending` (open items, also while offline).
   * ADR-152: the store reads a record's old `harborPending` as this
   * (store/sessions.ts), so saving drops the old name.
   */
  const refresh = (sid: string) => {
    const changed = store.atomic(() => {
      const s = store.session(sid);
      if (!s) return false;
      const next = pendingOf(sid);
      if (JSON.stringify(s.schedulerPending || []) === JSON.stringify(next))
        return false;
      if (next.length) s.schedulerPending = next;
      else delete s.schedulerPending;
      store.save(s);
      return true;
    });
    if (changed) deps.touched(sid);
  };
  const patch = (
    row: any,
    status: ScheduleStatus,
    extra: Partial<DaisySchedule> = {},
    nextAt: number | null = row.next_at ?? null,
  ) => {
    // The row as stored now: a report kept or delivered since `row` was
    // read is not overwritten.
    const cur = store.one(
      "SELECT data FROM agent_schedules WHERE id=?",
      row.id,
    );
    const data = { ...JSON.parse(cur?.data ?? row.data), ...extra };
    store.run(
      "UPDATE agent_schedules SET status=?,next_at=?,data=?,updated=? WHERE id=?",
      status,
      nextAt,
      JSON.stringify(data),
      Date.now(),
      row.id,
    );
  };
  /** Keep the newest ended rows only (and every one with a report still to deliver). */
  const prune = (sid: string) =>
    store.run(
      `DELETE FROM agent_schedules WHERE session_id=? AND status NOT IN ('active','running','paused') AND report_at IS NULL AND id NOT IN (
         SELECT id FROM agent_schedules WHERE session_id=? AND status NOT IN ('active','running','paused') ORDER BY updated DESC LIMIT ?)`,
      sid,
      sid,
      KEEP_ENDED,
    );
  /**
   * Turns the session started by itself in the last 24 hours (the
   * daily budget): its timers, its own wakes, plugin callbacks that were not a
   * person's decision (review 2026-11-03). A person's decision on
   * its request (callback-human) is not counted. (P1-01: turns another AI
   * brought about through 群聊 counted too; stage 4 counts A2A calls.)
   */
  const turnsToday = (sid: string) =>
    store.one(
      `SELECT COUNT(*) AS n FROM jobs j WHERE (j.session_id=? OR j.session_id IN (
        SELECT id FROM ask_sidecars WHERE parent=?)) AND j.created>?
        AND j.id NOT IN (SELECT job_id FROM queue_merges) AND (
        (j.origin IN ('schedule','agent') AND COALESCE(j.request_id,'') NOT LIKE 'schedule:callback-human:%')
        OR (COALESCE(j.request_id,'') LIKE 'classifier-retry:%' AND j.id IN (SELECT job_id FROM native_appends)))`,
      sid,
      sid,
      Date.now() - DAY,
    ).n as number;
  const overBudget = (s: Session) =>
    !!s.resident?.dailyTurns && turnsToday(s.id) >= s.resident.dailyTurns;
  /**
   * Queue a turn that tells the Agent `text` (a timer fired, background
   * work reported). A wake of the same item still waiting to run takes the
   * new text instead of a second turn. Returns why nothing was queued.
   * `budget: false` (plugin callbacks): the daily limit does not
   * hold it back.
   */
  const wake = (
    sid: string,
    scheduleId: string,
    label: string,
    text: string,
    /** `merge: false`: always a turn of its own (not into a waiting one). */
    opts: { budget?: boolean; merge?: boolean } = {},
  ): WakeResult => {
    const events: (Event | null)[] = [];
    const out = store.atomic(() => {
      const s = store.session(sid);
      if (!s || s.deleting || s.archived || residentHeld(s)) return "gone";
      const now = Date.now();
      const waiting = store.one(
        "SELECT id,text FROM jobs WHERE session_id=? AND origin='schedule' AND status IN ('queued','pending') AND request_id LIKE ? ORDER BY created LIMIT 1",
        sid,
        `schedule:${scheduleId}:%`,
      );
      if (waiting && opts.merge !== false) {
        store.run(
          "UPDATE jobs SET text=? WHERE id=?",
          clip(`${waiting.text}\n\n${text}`, COALESCE_MAX, sessionT(s)),
          waiting.id,
        );
        return "merged";
      }
      // a wake of this item appended into the running
      // turn whose text the Runner has not taken yet takes the new text
      // too (one delivery). Once taken, a new wake is a new one (counted).
      const held =
        opts.merge !== false
          ? store.one(
              `SELECT j.id,j.text,i.id input FROM jobs j JOIN native_appends n ON n.job_id=j.id
               JOIN live_inputs i ON i.id=n.input_id
               WHERE j.session_id=? AND j.origin='schedule' AND j.status='appended'
               AND n.state='waiting' AND i.status='queued' AND j.request_id LIKE ? LIMIT 1`,
              sid,
              `schedule:${scheduleId}:%`,
            )
          : null;
      if (held) {
        const next = clip(`${held.text}\n\n${text}`, COALESCE_MAX, sessionT(s));
        store.run("UPDATE jobs SET text=? WHERE id=?", next, held.id);
        store.run("UPDATE live_inputs SET text=? WHERE id=?", next, held.input);
        return "merged";
      }
      if (opts.budget !== false && overBudget(s)) {
        // Once a day: say so in the conversation and to its owner.
        const day = new Date(now).toISOString().slice(0, 10);
        const key = `budget:${day}`;
        if (
          !store.one(
            "SELECT 1 FROM items WHERE session_id=? AND id=?",
            sid,
            key,
          )
        ) {
          events.push(
            store.append(sid, "item", {
              id: key,
              kind: "notice",
              category: "lifecycle",
              text: sessionT(s)("prompt-schedule.budget.notice", { n: s.resident!.dailyTurns! }),
              status: "complete",
              createdAt: now,
            }),
          );
          deps.notifications.emit({
            userId: s.ownerId,
            kind: "ai_failed",
            key: `resident-budget:${sid}:${day}`,
            title: sessionT(s)("prompt-schedule.budget.title", { title: s.title }),
            sessionId: sid,
            subject: label,
            notificationId: `resident-budget:${sid}`,
          });
        }
        return "budget";
      }
      if (
        store.one(
          "SELECT COUNT(*) AS n FROM jobs WHERE session_id=? AND status='pending'",
          sid,
        ).n >= 20
      )
        return "full";
      const active = store.one(
        "SELECT id FROM jobs WHERE session_id=? AND status IN ('queued','running')",
        sid,
      );
      const jid = id();
      store.run(
        "INSERT INTO jobs(id,session_id,node_id,request_id,text,attachments,status,created,origin,wake,trace) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        jid,
        sid,
        s.nodeId,
        `schedule:${scheduleId}:${jid}`,
        clip(text, COALESCE_MAX, sessionT(s)),
        "[]",
        active ? "pending" : "queued",
        now,
        "schedule",
        label.slice(0, 500),
        traceForNewTurn(),
      );
      events.push(
        store.append(sid, "item", {
          id: `wake:${jid}`,
          kind: "notice",
          category: "wake",
          text: label.slice(0, 500),
          status: "complete",
          createdAt: now,
        }),
      );
      if (!active)
        events.push(store.append(sid, "status", { status: "queued" }));
      // A wake after 「下线」 brings it back online, like a message.
      store.run("UPDATE live_sessions SET stop=0 WHERE session_id=?", sid);
      return "queued";
    });
    for (const e of events) deps.broadcast(e);
    return out;
  };
  // ------------------------------------------------------------ kept reports
  /**
   * A row's kept report: `undelivered = {reason, since, attempts, head,
   * text}`; `report_at` the next attempt to wake the session for it (null:
   * nothing kept). The text is taken only when a turn of the session is
   * claimed (R2 review N-M1 / N-M3: `claimReports`), never at enqueue.
   */
  const saveU = (rowId: string, u: any, at?: number) => {
    const cur = store.one(
      "SELECT data,report_at FROM agent_schedules WHERE id=?",
      rowId,
    );
    if (!cur) return;
    const d = JSON.parse(cur.data);
    let next: number | null = null;
    if (u?.text) {
      d.undelivered = u;
      next = at ?? cur.report_at ?? Date.now();
    } else delete d.undelivered;
    store.run(
      "UPDATE agent_schedules SET data=?,report_at=? WHERE id=?",
      JSON.stringify(d),
      next,
      rowId,
    );
  };
  const dropU = (rowId: string) => saveU(rowId, null);
  /**
   * Keep a report the Agent could not be woken with (queue full, budget used
   * up, monitor interval): appended to what the row already keeps, tried
   * again at `at` (default: by reason).
   */
  const defer = (
    rowId: string,
    reason: "full" | "budget" | "throttle",
    head: string,
    text: string,
    at?: number,
  ) => {
    const cur = store.one("SELECT * FROM agent_schedules WHERE id=?", rowId);
    if (!cur) return;
    const now = Date.now(),
      u = JSON.parse(cur.data).undelivered;
    const retry =
      at ??
      now +
        (reason === "budget"
          ? RETRY_BUDGET_MS
          : reason === "full"
            ? RETRY_FULL_MS
            : 0);
    saveU(
      rowId,
      {
        // A full queue / the budget says more than 「interval」.
        reason: u?.text && reason === "throttle" ? u.reason : reason,
        since: u?.since ?? now,
        attempts: u?.attempts ?? 0,
        head: head.slice(0, 480),
        text: clip(u?.text ? `${u.text}\n\n${text}` : text, REPORT_MAX, tOf(cur.session_id)),
      },
      cur.report_at != null && reason === "throttle"
        ? Math.min(cur.report_at, retry)
        : retry,
    );
  };
  /** One line per kept report (review H1: every row is named, whatever fits). */
  const summaryOf = (t: PromptT, r: any) => {
    const d = JSON.parse(r.data);
    return t("prompt-schedule.summary", {
      id: r.id,
      kind: t(r.kind === "bash" ? "prompt-schedule.kind.bash" : "prompt-schedule.kind.monitor"),
      label: String(d.label || "").slice(0, 80),
      status: statusWords(t, r.status),
      exit: d.exitCode !== undefined && d.exitCode !== null ? t("prompt-schedule.summary.exit", { code: d.exitCode }) : "",
      output: d.outputPath ? t("prompt-schedule.summary.output", { path: d.outputPath }) : "",
    });
  };
  /**
   * Take the session's kept reports (inside the caller's transaction), at
   * most CARRY_MAX characters; "" when there are none. Each report is cut
   * on its own (PER_REPORT); one that does not fit stays kept for a later
   * turn (only its line is listed) and is tried again RETRY_FULL_MS later.
   */
  const carryReports = (sid: string, room: number) => {
    let rows = store.all(
      "SELECT * FROM agent_schedules WHERE session_id=? AND report_at IS NOT NULL ORDER BY created",
      sid,
    );
    if (!rows.length) return "";
    const t = tOf(sid);
    // The list of lines takes at most half the room.
    let lines = rows.map((x) => summaryOf(t, x));
    while (rows.length > 1 && lines.join("\n").length > room / 2) {
      rows = rows.slice(0, -1);
      lines = lines.slice(0, -1);
    }
    let out = `${t("prompt-schedule.carry.reports", { n: rows.length })}\n${lines.join("\n")}`;
    const later: string[] = [],
      now = Date.now();
    for (const r of rows) {
      const u = JSON.parse(r.data).undelivered;
      if (!u?.text) {
        dropU(r.id);
        continue;
      }
      const body = fence(clip(u.text, PER_REPORT, t));
      if (out.length + 2 + body.length > room - 300) {
        later.push(r.id);
        // Later, not at once (R2 review N-M3: no wake every second).
        saveU(r.id, u, now + RETRY_FULL_MS);
        continue;
      }
      out += `\n\n${body}`;
      dropU(r.id);
    }
    if (later.length)
      out += `\n\n${t("prompt-schedule.carry.reportsLater", { ids: later.join(t("prompt-schedule.listSep")) })}`;
    return out;
  };
  // ------------------------------------------------- kept callbacks
  /**
   * Keep a callback wake for the session's next turn: `budget` (the daily
   * limit held it back — also tried again on its own every minute, held to
   * the limit) or `stopped` (its wake was stopped before it ran — next turn
   * only: stop means stop). One row per scheduleId; a later one appends.
   */
  const keepCallback = (
    sid: string,
    scheduleId: string,
    label: string,
    text: string,
    reason: "budget" | "stopped",
    opts: { budget?: boolean } = {},
  ) =>
    store.atomic(() => {
      const id = `${sid}:${scheduleId}`,
        now = Date.now(),
        cur = store.one("SELECT * FROM kept_callbacks WHERE id=?", id);
      const retry = reason === "budget" ? now + RETRY_BUDGET_MS : null;
      const at =
        cur?.report_at != null
          ? retry === null
            ? cur.report_at
            : Math.min(cur.report_at, retry)
          : retry;
      if (cur)
        store.run(
          "UPDATE kept_callbacks SET label=?,text=?,reason=?,report_at=?,budget=?,created=? WHERE id=?",
          label.slice(0, 480),
          clip(`${cur.text}\n\n${text}`, REPORT_MAX, tOf(sid)),
          cur.reason === "budget" ? "budget" : reason,
          at,
          cur.budget && opts.budget !== false ? 1 : 0,
          now,
          id,
        );
      else
        store.run(
          "INSERT INTO kept_callbacks(id,session_id,schedule_id,label,text,reason,budget,attempts,report_at,created) VALUES(?,?,?,?,?,?,?,0,?,?)",
          id,
          sid,
          scheduleId,
          label.slice(0, 480),
          clip(text, REPORT_MAX, tOf(sid)),
          reason,
          opts.budget === false ? 0 : 1,
          at,
          now,
        );
      // Review L4: at most KEPT_MAX per session; the oldest go (logged).
      const over = store.all(
        "SELECT id FROM kept_callbacks WHERE session_id=? ORDER BY created DESC, id DESC LIMIT -1 OFFSET ?",
        sid,
        KEPT_MAX,
      );
      for (const r of over)
        store.run("DELETE FROM kept_callbacks WHERE id=?", r.id);
      if (over.length)
        log.info(
          `[callback] session=${sid} dropped ${over.length} kept callback(s) over the cap ${KEPT_MAX}`,
        );
    });
  /** Review L4: kept callbacks older than KEPT_STALE_MS are dropped (logged). */
  const dropStaleKept = (now = Date.now(), sid?: string) => {
    const r = store.run(
      `DELETE FROM kept_callbacks WHERE created<?${sid ? " AND session_id=?" : ""}`,
      now - KEPT_STALE_MS,
      ...(sid ? [sid] : []),
    ) as any;
    if (r?.changes)
      log.info(
        `[callback] ${sid ? `session=${sid} ` : ""}dropped ${r.changes} kept callback(s) older than 7 days`,
      );
  };
  /**
   * A callback wake job stopped before any Runner claimed it (stopWork, a
   * paused resident's claim): its text is not voided — a paused / archived
   * resident holds it, an archived conversation drops it, else it
   * goes with the next turn. Returns what became of it (null: not a
   * callback wake).
   */
  const keepStopped = (
    s: Session,
    job: any,
  ): { scheduleId: string; result: "kept" | "held" | "gone" } | null => {
    const rid = String(job?.request_id || "");
    // Review M1: the sweep's own wake was stopped — what it was for stays
    // kept, but rides the next turn only (no wake of its own again).
    if (
      job?.origin === "schedule" &&
      rid.startsWith(`schedule:${KEPT_WAKE}:`)
    ) {
      store.run(
        "UPDATE kept_callbacks SET report_at=NULL WHERE session_id=?",
        s.id,
      );
      return null;
    }
    // a callback wake job: the generic frame (ADR-157).
    const cb = callbackJob(rid);
    if (!cb || job.origin !== "schedule" || !job.text) return null;
    const scheduleId = cb.scheduleId,
      budget = !cb.human,
      label = String(job.wake || scheduleId);
    if (s.deleting) return { scheduleId, result: "gone" };
    if (residentHeld(s)) {
      hold(s.id, scheduleId, label, job.text, { budget });
      return { scheduleId, result: "held" };
    }
    if (s.archived) return { scheduleId, result: "gone" };
    keepCallback(s.id, scheduleId, label, job.text, "stopped", { budget });
    return { scheduleId, result: "kept" };
  };
  /** Take the session's kept callbacks (caller's transaction), at most `room`. */
  const carryCallbacks = (sid: string, room: number) => {
    const now = Date.now();
    dropStaleKept(now, sid);
    const rows = store.all(
      "SELECT * FROM kept_callbacks WHERE session_id=? ORDER BY created, id",
      sid,
    );
    if (!rows.length) return "";
    const t = tOf(sid);
    const bodies: string[] = [],
      later: string[] = [];
    let used = 100;
    for (const r of rows) {
      const body = fence(clip(r.text, PER_REPORT, t));
      if (bodies.length && used + 2 + body.length > room - 300) {
        later.push(String(r.schedule_id).split(":").at(-1)!);
        // Review L3: a stopped one (no wake of its own) stays so.
        if (r.report_at != null)
          store.run(
            "UPDATE kept_callbacks SET report_at=? WHERE id=?",
            now + RETRY_FULL_MS,
            r.id,
          );
        continue;
      }
      bodies.push(body);
      used += 2 + body.length;
      store.run("DELETE FROM kept_callbacks WHERE id=?", r.id);
    }
    // Review L5: the count is of what this turn carries.
    let out = `${t("prompt-schedule.carry.callbacks", { n: bodies.length })}\n\n${bodies.join("\n\n")}`;
    if (later.length)
      out += `\n\n${t("prompt-schedule.carry.callbacksLater", { ids: later.join(t("prompt-schedule.listSep")) })}`;
    log.info(
      `[callback] session=${sid} carried ${bodies.length} kept callback(s)${later.length ? `, ${later.length} later` : ""}`,
    );
    return out;
  };
  /** Kept callbacks first (short, a person may be waiting), then kept reports. */
  const carry = (sid: string) => {
    const a = carryCallbacks(sid, CARRY_MAX / 2);
    const b = carryReports(sid, CARRY_MAX - a.length);
    return [a, b].filter(Boolean).join("\n\n");
  };
  /**
   * Kept callbacks that are due (budget): when no turn of the session is
   * about to be claimed, a wake of its own — still held to the daily
   * budget — whose claim takes them all; else later.
   */
  const redeliverCallbacks = (now = Date.now()) => {
    const due = store.all(
      "SELECT session_id, MIN(report_at) AS at FROM kept_callbacks WHERE report_at IS NOT NULL AND report_at<=? GROUP BY session_id ORDER BY at LIMIT 100",
      now,
    );
    for (const d of due)
      try {
        store.atomic(() => {
          const sid = d.session_id,
            s = store.session(sid),
            rows = store.all(
              "SELECT * FROM kept_callbacks WHERE session_id=? ORDER BY created, id",
              sid,
            );
          if (!rows.length) return;
          const drop = () =>
            store.run("DELETE FROM kept_callbacks WHERE session_id=?", sid);
          if (s && !s.deleting && residentHeld(s)) {
            for (const r of rows)
              hold(sid, r.schedule_id, r.label, r.text, {
                budget: !!r.budget,
              });
            return drop();
          }
          if (!s || s.deleting || s.archived) return drop();
          const later = (ms: number, bump = 0) =>
            store.run(
              "UPDATE kept_callbacks SET report_at=?,attempts=attempts+? WHERE session_id=? AND report_at IS NOT NULL",
              now + ms,
              bump,
              sid,
            );
          if (
            store.one(
              "SELECT 1 FROM jobs WHERE session_id=? AND status IN ('queued','running') LIMIT 1",
              sid,
            )
          )
            return later(RETRY_FULL_MS);
          const t = sessionT(s);
          const head = `${t(CALLBACK_HEAD)}${rows[0].label}${rows.length > 1 ? t("prompt-schedule.head.more", { n: rows.length }) : ""}`;
          const result = wake(
            sid,
            KEPT_WAKE,
            head.slice(0, 480),
            `${head}\n${t("prompt-schedule.redeliver.body", { why: reasonWords(t, "budget") })}`,
            { merge: false },
          );
          if (result === "budget") later(RETRY_BUDGET_MS, 1);
          else if (result === "full") later(RETRY_FULL_MS, 1);
          else if (result === "gone") drop();
          else later(RETRY_FULL_MS);
        });
      } catch (e) {
        log.error(
          "[scheduler] redeliver callbacks",
          (e as Error)?.message || e,
        );
      }
  };
  /**
   * A turn of the session is being claimed (/runner/claim or a live
   * process's own turn, both through jobPayload): its kept reports go into
   * this turn's `preamble` and are cleared, in one transaction. A turn the
   * Runner claimed has delivered them, whatever happens to it later (a
   * re-claim sends the same preamble). Operations and slash commands take
   * none. Returns the job as it is to be sent.
   */
  const claimReports = (job: any) =>
    store.atomic(() => {
      if (!job?.id || !job.session_id) return job;
      if (
        String(job.text || "")
          .trimStart()
          .startsWith("/")
      )
        return job;
      if (store.one("SELECT 1 FROM job_operations WHERE job_id=?", job.id))
        return job;
      // R3 review: an AI-initiated turn (origin 'agent') sends no prompt, so
      // reports put there would be cleared yet never seen; a collaboration
      // request (chat:) or an understanding turn answers someone else and
      // must not carry the owner's background output into a group. Both
      // leave the reports on the row; redeliver wakes after this turn.
      const rid = String(job.request_id || "");
      if (
        job.origin === "agent" ||
        rid.startsWith("chat:") ||
        rid.startsWith("understanding:")
      )
        return job;
      const extra = carry(job.session_id);
      if (!extra) {
        // A 补送 wake whose reports an earlier turn already took.
        if (isRedeliveryWake(job.text))
          return {
            ...job,
            text: `${job.text}\n${tOf(job.session_id)("prompt-schedule.redeliver.taken")}`,
          };
        return job;
      }
      const preamble = job.preamble ? `${job.preamble}\n\n${extra}` : extra;
      store.run("UPDATE jobs SET preamble=? WHERE id=?", preamble, job.id);
      return { ...job, preamble };
    });
  /** Wake with a background report; kept for later when it cannot wake now. */
  const report = (sid: string, rowId: string, head: string, text: string) => {
    const r = wake(sid, rowId, head, text);
    if (r === "budget" || r === "full") defer(rowId, r, head, text);
    return r;
  };
  /**
   * Kept reports that are due: when no turn of the session is about to be
   * claimed, a wake of its own (the claim takes them all); else later.
   * Each session on its own (R2 review N-L5: one failing does not stop the
   * others).
   */
  const redeliver = (now = Date.now()) => {
    const due = store.all(
      "SELECT session_id, MIN(report_at) AS at FROM agent_schedules WHERE report_at IS NOT NULL AND report_at<=? GROUP BY session_id ORDER BY at LIMIT 100",
      now,
    );
    for (const d of due)
      try {
        store.atomic(() => {
          const sid = d.session_id,
            s = store.session(sid),
            rows = store.all(
              "SELECT * FROM agent_schedules WHERE session_id=? AND report_at IS NOT NULL ORDER BY report_at",
              sid,
            );
          const r = rows[0],
            u = r && JSON.parse(r.data).undelivered;
          if (!r) return;
          if (!s || s.deleting || s.archived || residentHeld(s) || !u) {
            for (const x of rows) dropU(x.id);
            return;
          }
          const later = (ms: number, bump?: string) => {
            for (const x of rows) {
              const xu = JSON.parse(x.data).undelivered;
              if (!xu?.text) continue;
              saveU(
                x.id,
                bump
                  ? { ...xu, reason: bump, attempts: (xu.attempts || 0) + 1 }
                  : xu,
                now + ms,
              );
            }
          };
          // A turn will be claimed soon (queued, or behind a running one):
          // it takes them; nothing to queue.
          if (
            store.one(
              "SELECT 1 FROM jobs WHERE session_id=? AND status IN ('queued','running') LIMIT 1",
              sid,
            )
          )
            return later(RETRY_FULL_MS);
          const t = sessionT(s);
          const head = `${t(REDELIVER_HEAD)}${u.head}${rows.length > 1 ? t("prompt-schedule.head.more", { n: rows.length }) : ""}`;
          const result = wake(
            sid,
            r.id,
            head.slice(0, 480),
            `${head}\n${t("prompt-schedule.redeliver.body", { why: reasonWords(t, u.reason) })}`,
            // Its own turn: a waiting one in a paused queue might never run.
            { merge: false },
          );
          if (result === "budget" || result === "full")
            later(
              result === "budget" ? RETRY_BUDGET_MS : RETRY_FULL_MS,
              result,
            );
          else if (result === "gone") for (const x of rows) dropU(x.id);
          else {
            // Queued: its claim takes them; until then, not again.
            later(RETRY_FULL_MS);
            // A monitor's interval counts from this wake too.
            for (const x of rows)
              if (x.kind === "monitor")
                patch(x, x.status, { lastFiredAt: now });
          }
        });
      } catch (e) {
        log.error("[scheduler] redeliver", (e as Error)?.message || e);
      }
  };
  /** A monitor waits this long after the session's last monitor wake (budget-aware). */
  const monitorGap = (s: Session) =>
    Math.max(
      limits.monitorMinIntervalMs,
      s.resident?.dailyTurns ? Math.ceil(DAY / s.resident.dailyTurns) : 0,
    );
  const lastMonitorWake = (sid: string) =>
    (store.one(
      "SELECT MAX(json_extract(data,'$.lastFiredAt')) AS t FROM agent_schedules WHERE session_id=? AND kind='monitor'",
      sid,
    )?.t as number | null) ?? null;
  const waitingWake = (sid: string, rowId: string) =>
    !!store.one(
      "SELECT 1 FROM jobs WHERE session_id=? AND origin='schedule' AND status IN ('queued','pending') AND request_id LIKE ? LIMIT 1",
      sid,
      `schedule:${rowId}:%`,
    );
  /** Validate and insert one item (the Agent's tool or its owner). */
  const create = (
    s: Session,
    raw: ScheduleCreate,
    by: "agent" | "owner",
    /** The Runner turn whose tool call this is. */
    originJob: string | null = null,
    /** P6-24: how a refusal is said (default: the session's language, for its Agent). */
    refuse: Refuse = agentRefuse(s),
    /** …and the words of a cron that cannot be read. */
    say: { dynamic(k: string, p?: Record<string, unknown>): string } = sessionT(s),
  ): DaisySchedule => {
    const b = ScheduleCreateSchema.parse(raw);
    if (s.sidecar) refuse(403, "prompt-schedule.error.sidecar");
    if (s.archived || s.deleting || residentHeld(s))
      refuse(409, s.resident ? "prompt-schedule.error.residentHeld" : "prompt-schedule.error.archived");
    const now = Date.now(),
      sid = s.id;
    const row = store.atomic(() => {
      const open = openRows(sid),
        timers = open.filter((r) => ["wakeup", "cron"].includes(r.kind)).length,
        background = open.length - timers;
      const timer = b.kind === "wakeup" || b.kind === "cron";
      if (timer && timers >= SCHEDULE_LIMITS.timers)
        refuse(429, "prompt-schedule.error.timers", { n: SCHEDULE_LIMITS.timers }, "schedule_limit");
      if (!timer && background >= limits.sessionBackground)
        refuse(429, "prompt-schedule.error.background", { n: limits.sessionBackground }, "schedule_limit");
      // the node's share, all of its sessions together.
      if (!timer) {
        const onNode = store.one(
          "SELECT COUNT(*) AS n FROM agent_schedules WHERE node_id=? AND status='running' AND kind IN ('bash','monitor')",
          s.nodeId,
        ).n as number;
        if (onNode >= limits.nodeBackground)
          refuse(429, "prompt-schedule.error.node", { n: onNode, max: limits.nodeBackground }, "node_limit");
      }
      let nextAt: number | null = null,
        data: Omit<
          DaisySchedule,
          "id" | "sessionId" | "kind" | "status" | "createdAt" | "updatedAt"
        >;
      if (b.kind === "wakeup") {
        nextAt = now + b.delaySeconds * 1000;
        data = {
          label: b.reason || b.prompt.slice(0, 80),
          prompt: b.prompt,
          createdBy: by,
          fires: 0,
        };
      } else if (b.kind === "cron") {
        let cron;
        try {
          cron = parseCron(b.cron);
        } catch (e: any) {
          return refuse(400, "prompt-schedule.error.cronInvalid", { why: cronWhy(say, e) }, "cron_invalid");
        }
        nextAt = nextCron(cron, now);
        if (nextAt === null) refuse(400, "prompt-schedule.error.cronNever", {}, "cron_invalid");
        if (cronGap(b.cron, now) < 60_000) refuse(400, "prompt-schedule.error.cronGap", {}, "cron_invalid");
        data = {
          label: b.label || b.prompt.slice(0, 80),
          prompt: b.prompt,
          cron: b.cron,
          recurring: b.recurring,
          expiresAt: b.recurring ? now + b.expiresInDays * DAY : null,
          createdBy: by,
          fires: 0,
        };
      } else {
        if (by !== "agent") refuse(403, "prompt-schedule.error.ownerBackground");
        if (b.kind === "monitor" && b.pattern)
          try {
            new RegExp(b.pattern);
          } catch {
            refuse(400, "prompt-schedule.error.pattern");
          }
        nextAt = now + b.timeoutSeconds * 1000;
        data = {
          label: b.description || b.command.slice(0, 80),
          command: b.command,
          ...(b.kind === "monitor" && b.pattern ? { pattern: b.pattern } : {}),
          createdBy: by,
          fires: 0,
        };
      }
      // Security re-review M-1: the turn that set it, so that
      // when it fires the turn speaks for whoever drove that one (not
      // simply for the owner). Her own timers (by "owner") are hers.
      // N-1: the job the Runner names (the turn that made the tool call —
      // a late call from a finished turn names that turn, never the next
      // one), checked to be this session's and recent. Never guessed: an
      // older Runner that names none leaves it unknown (not the owner).
      if (by === "agent") {
        const creator =
          originJob &&
          store.one(
            "SELECT id FROM jobs WHERE id=? AND session_id=? AND (status='running' OR created>?)",
            originJob,
            s.id,
            Date.now() - 6 * 3600_000,
          );
        (data as any).creatorJob = creator?.id ?? null;
      }
      const sid2 = id();
      store.run(
        "INSERT INTO agent_schedules(id,session_id,node_id,kind,status,next_at,data,created,updated) VALUES(?,?,?,?,?,?,?,?,?)",
        sid2,
        sid,
        s.nodeId,
        b.kind,
        timer ? "active" : "running",
        nextAt,
        JSON.stringify(data),
        now,
        now,
      );
      prune(sid);
      return store.one("SELECT * FROM agent_schedules WHERE id=?", sid2);
    });
    refresh(sid);
    return view(row);
  };
  const cancel = (
    sid: string,
    scheduleId: string,
    reason: string,
    /** P6-24: default — the session's language. */
    refuse: Refuse = agentRefuse(store.session(sid)),
  ) => {
    const row = store.one(
      "SELECT * FROM agent_schedules WHERE id=? AND session_id=?",
      scheduleId,
      sid,
    );
    if (!row) refuse(404, "prompt-schedule.error.notFound");
    store.atomic(() => {
      const cur = store.one(
        "SELECT * FROM agent_schedules WHERE id=?",
        scheduleId,
      );
      if (!cur || !["active", "running", "paused"].includes(cur.status)) return;
      patch(cur, "canceled", { endedReason: reason });
      // Stopped while open: what it had not reported yet is not wanted
      // either. An ended one keeps its report (review L12).
      dropU(cur.id);
    });
    refresh(sid);
    return view(
      store.one("SELECT * FROM agent_schedules WHERE id=?", scheduleId),
    );
  };
  /**
   * keep a wake for a paused / archived resident (a plugin's
   * result it waits for) instead of dropping it; one per scheduleId.
   */
  const hold = (
    sid: string,
    scheduleId: string,
    label: string,
    text: string,
    opts: { budget?: boolean } = {},
  ) =>
    store.atomic(() => {
      // a second result for the same item is added to
      // the one held (before, it replaced it). A machine result held with a
      // person's keeps the person's (no budget).
      const cur = store.one(
        "SELECT text,budget,created FROM resident_held_wakes WHERE id=?",
        `${sid}:${scheduleId}`,
      );
      store.run(
        "INSERT OR REPLACE INTO resident_held_wakes(id,session_id,schedule_id,label,text,budget,created) VALUES(?,?,?,?,?,?,?)",
        `${sid}:${scheduleId}`,
        sid,
        scheduleId,
        label,
        cur ? clip(`${cur.text}\n\n${text}`, REPORT_MAX, tOf(sid)) : text,
        cur && !cur.budget ? 0 : opts.budget === false ? 0 : 1,
        Date.now(),
      );
      // Review L4: at most HELD_MAX per resident; the oldest go, counted
      // (said once on release).
      const over = store.all(
        `SELECT id FROM resident_held_wakes WHERE session_id=? AND schedule_id!='${HELD_DROPPED}'
         ORDER BY created DESC, id DESC LIMIT -1 OFFSET ?`,
        sid,
        HELD_MAX,
      );
      if (!over.length) return;
      for (const r of over)
        store.run("DELETE FROM resident_held_wakes WHERE id=?", r.id);
      const prev = store.one(
        "SELECT text FROM resident_held_wakes WHERE id=?",
        `${sid}:${HELD_DROPPED}`,
      );
      store.run(
        "INSERT OR REPLACE INTO resident_held_wakes(id,session_id,schedule_id,label,text,budget,created) VALUES(?,?,?,?,?,0,?)",
        `${sid}:${HELD_DROPPED}`,
        sid,
        HELD_DROPPED,
        tOf(sid)("prompt-schedule.held.droppedLabel"),
        String((Number(prev?.text) || 0) + over.length),
        Date.now(),
      );
    });
  /**
   * 恢复运行: deliver what was held, once each — wake and delete in
   * one transaction (review M: inside the resume's own when called from
   * it), so a crash neither strands nor repeats a result. A full queue /
   * gone keeps the row (the tick tries again). Older than STALE: one
   * summary line instead of stale text; dropped over the cap: said once.
   * A machine result past the daily budget is kept for the next turn.
   */
  const releaseHeld = (sid: string, now = Date.now()) =>
    store.atomic(() => {
      const out: WakeResult[] = [];
      const rows = store.all(
        "SELECT * FROM resident_held_wakes WHERE session_id=? ORDER BY created",
        sid,
      );
      const stale = rows.filter(
        (r) =>
          r.schedule_id !== HELD_DROPPED && now - r.created > HELD_STALE_MS,
      );
      const dropped = rows.find((r) => r.schedule_id === HELD_DROPPED);
      const t = tOf(sid);
      const words = [
        stale.length ? t("prompt-schedule.held.stale", { n: stale.length }) : "",
        dropped ? t("prompt-schedule.held.dropped", { n: dropped.text, max: HELD_MAX }) : "",
      ].filter(Boolean);
      if (words.length) {
        const head = t("prompt-schedule.held.head");
        const res = wake(
          sid,
          "held-summary",
          `${head}${words.join(t("prompt-schedule.held.sep"))}`.slice(0, 480),
          `${head}\n${words.join("\n")}\n${t("prompt-schedule.held.check")}`,
          { budget: false, merge: false },
        );
        out.push(res);
        if (res === "full" || res === "gone") return out;
        for (const r of [...stale, ...(dropped ? [dropped] : [])])
          store.run("DELETE FROM resident_held_wakes WHERE id=?", r.id);
      }
      for (const r of rows) {
        if (r.schedule_id === HELD_DROPPED || stale.includes(r)) continue;
        const res = wake(sid, r.schedule_id, r.label, r.text, {
          budget: !!r.budget,
        });
        out.push(res);
        if (res === "full" || res === "gone") break;
        // past the daily budget it is kept for the next turn.
        if (res === "budget")
          keepCallback(sid, r.schedule_id, r.label, r.text, "budget");
        store.run("DELETE FROM resident_held_wakes WHERE id=?", r.id);
      }
      return out;
    });
  /** Review L2: held results left by a full queue go once there is room (every 10 s). */
  let heldTriedAt = 0;
  const retryHeld = (now: number) => {
    if (now - heldTriedAt < 10_000) return;
    heldTriedAt = now;
    for (const r of store.all(
      "SELECT DISTINCT session_id FROM resident_held_wakes LIMIT 100",
    )) {
      const s = store.session(r.session_id);
      if (!s || s.deleting || residentHeld(s)) continue;
      try {
        releaseHeld(s.id, now);
      } catch (e) {
        log.error("held results:", (e as Error).message);
      }
    }
  };
  /** Close everything a session has open (archived / deleted), held timers too. */
  const cancelAll = (sid: string, reason: string) => {
    store.run("DELETE FROM resident_held_wakes WHERE session_id=?", sid);
    store.run("DELETE FROM kept_callbacks WHERE session_id=?", sid);
    for (const r of [
      ...openRows(sid),
      ...store.all(
        "SELECT * FROM agent_schedules WHERE session_id=? AND status='paused'",
        sid,
      ),
    ])
      patch(r, "canceled", { endedReason: reason });
    for (const r of store.all(
      "SELECT id FROM agent_schedules WHERE session_id=? AND report_at IS NOT NULL",
      sid,
    ))
      dropU(r.id);
    refresh(sid);
  };
  /**
   * 暂停: a resident's timers are held as they are (`paused`);
   * background commands and monitors end (a process cannot be held: the
   * Runner stops them on its next report); reports not delivered yet are
   * dropped (nothing of its own runs until 恢复运行).
   */
  const pauseAll = (sid: string, reason: string) => {
    store.atomic(() => {
      for (const r of openRows(sid))
        if (["wakeup", "cron"].includes(r.kind)) patch(r, "paused");
        else {
          patch(r, "canceled", { endedReason: reason });
          dropU(r.id);
        }
      for (const r of store.all(
        "SELECT id FROM agent_schedules WHERE session_id=? AND report_at IS NOT NULL",
        sid,
      ))
        dropU(r.id);
      // kept callbacks are held like ones arriving now.
      for (const r of store.all(
        "SELECT * FROM kept_callbacks WHERE session_id=? ORDER BY created, id",
        sid,
      ))
        hold(sid, r.schedule_id, r.label, r.text, { budget: !!r.budget });
      store.run("DELETE FROM kept_callbacks WHERE session_id=?", sid);
    });
    refresh(sid);
  };
  /**
   * 恢复运行: held timers run again from now — a cron from its next
   * time after now (missed times are not made up), a one-time wake-up whose
   * time passed while paused expires (not fired late, by surprise).
   */
  const resumeAll = (sid: string, now = Date.now()) => {
    const out = { resumed: 0, expired: 0 };
    const t = tOf(sid);
    store.atomic(() => {
      for (const r of store.all(
        "SELECT * FROM agent_schedules WHERE session_id=? AND status='paused'",
        sid,
      )) {
        const d = JSON.parse(r.data);
        if (r.kind === "cron") {
          const next = nextCron(d.cron, now);
          if (next !== null && (!d.expiresAt || next <= d.expiresAt)) {
            patch(r, "active", {}, next);
            out.resumed++;
          } else {
            patch(
              r,
              "expired",
              { endedReason: t("prompt-schedule.ended.pausedExpired") },
              null,
            );
            out.expired++;
          }
        } else if ((r.next_at ?? 0) > now) {
          patch(r, "active");
          out.resumed++;
        } else {
          patch(
            r,
            "expired",
            { endedReason: t("prompt-schedule.ended.pausedMissed") },
            null,
          );
          out.expired++;
        }
      }
    });
    refresh(sid);
    return out;
  };
  let staleKeptAt = 0;
  /** Fire due timers (leader, every second). */
  const tick = (now = Date.now()) => {
    const due = store.all(
      "SELECT * FROM agent_schedules WHERE status='active' AND next_at<=? ORDER BY next_at LIMIT 100",
      now,
    );
    for (const r0 of due) store.atomic(() => fireOne(r0, now));
    redeliver(now);
    redeliverCallbacks(now);
    if (now - staleKeptAt >= 60_000) {
      staleKeptAt = now;
      dropStaleKept(now);
    }
    retryHeld(now);
  };
  const fireOne = (r0: any, now: number) => {
    {
      const r = store.one(
        "SELECT * FROM agent_schedules WHERE id=? AND status='active' AND next_at<=?",
        r0.id,
        now,
      );
      if (!r) return; // another process took it
      const s = view(r);
      const session = store.session(r.session_id);
      if (!session || session.deleting) {
        store.run("DELETE FROM agent_schedules WHERE id=?", r.id);
        return;
      }
      // a paused / archived resident's timer is held, not fired
      // (pauseAll already did it; this is the race with that).
      const t = sessionT(session);
      if (residentHeld(session)) {
        if (["wakeup", "cron"].includes(r.kind)) patch(r, "paused");
        else patch(r, "canceled", { endedReason: t("prompt-schedule.ended.residentPaused") });
        refresh(r.session_id);
        return;
      }
      if (session.archived) {
        patch(r, "canceled", { endedReason: t("prompt-schedule.ended.archived") });
        refresh(r.session_id);
        return;
      }
      // Claim it first (the next time / done): never fires twice.
      let next: number | null = null,
        status: ScheduleStatus = "done";
      if (s.kind === "cron" && s.recurring) {
        next = nextCron(s.cron!, now);
        status =
          next !== null && (!s.expiresAt || next <= s.expiresAt)
            ? "active"
            : "expired";
      }
      const fires = (s.fires || 0) + 1;
      patch(
        r,
        status,
        {
          fires,
          lastFiredAt: now,
          ...(status === "expired"
            ? { endedReason: t("prompt-schedule.ended.expired") }
            : {}),
        },
        status === "active" ? next : null,
      );
      const late = now - (r.next_at || now) > 5 * 60_000;
      const head =
        s.kind === "wakeup"
          ? t("prompt-schedule.fire.wakeup", { label: s.label, late: late ? t("prompt-schedule.fire.late") : "" })
          : t("prompt-schedule.fire.cron", {
              label: s.label,
              cron: s.cron!,
              n: fires,
              tail:
                status === "active" && next
                  ? t("prompt-schedule.fire.next", { when: new Date(next).toLocaleString(t.lang, { hour12: false }) })
                  : status === "expired"
                    ? t("prompt-schedule.fire.last")
                    : "",
            });
      const result = wake(
        r.session_id,
        r.id,
        head.slice(0, 480),
        `${head}\n${t("prompt-schedule.fire.id", { id: r.id })}\n${s.prompt || ""}`,
      );
      const after = store.one("SELECT * FROM agent_schedules WHERE id=?", r.id);
      if (result === "gone")
        patch(after, "canceled", { endedReason: t("prompt-schedule.ended.gone") }, null);
      else if (result === "budget" || result === "full")
        patch(after, after.status, {
          skipped: (JSON.parse(after.data).skipped || 0) + 1,
          ...(after.status !== "active"
            ? {
                endedReason:
                  result === "budget"
                    ? t("prompt-schedule.ended.budget")
                    : t("prompt-schedule.ended.full"),
              }
            : {}),
        } as any);
      refresh(r.session_id);
    }
  };
  const sweep = setInterval(() => {
    try {
      if (deps.leading()) tick();
    } catch (e) {
      log.error("[scheduler]", (e as Error)?.message || e);
    }
  }, 1000);
  (sweep as unknown as NodeJS.Timeout).unref();
  app.addHook("onClose", async () => clearInterval(sweep));
  /** A session of the calling node (the Runner acts for its own sessions only). */
  const nodeSession = (req: any) => {
    const n = deps.claimingNode(req),
      s = store.session(req.params.sid);
    const refuse = agentRefuse(s);
    if (!s || s.deleting || s.nodeId !== n.id) refuse(410, "prompt-schedule.error.gone", {}, "gone");
    // a read-only 「只问」 sidecar has no timers or background work.
    if (s!.sidecar) refuse(403, "prompt-schedule.error.sidecarTools");
    return s!;
  };
  /** Background output / exit → the Agent's next turn says what happened. */
  const event = (s: Session, row: any, raw: unknown) => {
    const b = ScheduleEventSchema.parse(raw),
      sch = view(row),
      t = sessionT(s);
    const what = t(sch.kind === "bash" ? "prompt-schedule.kind.bash" : "prompt-schedule.kind.monitor");
    if (b.type === "output") {
      if (row.status !== "running" || !b.text.trim()) return "ignored";
      const now = Date.now(),
        head = t("prompt-schedule.event.output", { what, label: sch.label }),
        text = `${t("prompt-schedule.event.id", { head, id: row.id })}\n\`\`\`\n${b.text.slice(-SCHEDULE_LIMITS.monitorChars)}\n\`\`\``;
      // one monitor wake per interval and session; a wake still
      // waiting to run takes the lines anyway (no extra turn).
      if (!waitingWake(s.id, row.id)) {
        const last = lastMonitorWake(s.id),
          gap = monitorGap(s);
        if (last && now - last < gap) {
          defer(row.id, "throttle", head, text, last + gap);
          return "throttled";
        }
      }
      const r = report(s.id, row.id, head, text);
      if (r === "queued" || r === "merged")
        patch(row, "running", {
          fires: (sch.fires || 0) + 1,
          ...(r === "queued" ? { lastFiredAt: now } : {}),
        });
      return r;
    }
    // exit
    const wasRunning = row.status === "running";
    const ok = b.exitCode === 0 && !b.reason;
    patch(
      row,
      wasRunning ? (b.lost ? "lost" : ok ? "done" : "failed") : row.status,
      {
        exitCode: b.exitCode ?? null,
        ...(b.outputPath ? { outputPath: b.outputPath } : {}),
        ...(b.reason || !wasRunning
          ? { endedReason: b.reason || JSON.parse(row.data).endedReason }
          : {}),
      },
      null,
    );
    refresh(s.id);
    // Canceled by the Agent / its owner: nobody is waiting for a report.
    if (!wasRunning) return "ignored";
    const head = t(b.lost ? "prompt-schedule.event.lost" : "prompt-schedule.event.exit", {
      what,
      label: sch.label,
      why:
        b.reason ||
        t("prompt-schedule.event.exitCode", {
          code: b.exitCode ?? t("prompt-schedule.event.exitUnknown"),
        }),
    });
    // kept when it cannot wake now (never dropped).
    const r = report(
      s.id,
      row.id,
      head.slice(0, 480),
      `${t("prompt-schedule.event.id", { head, id: row.id })}\n${t("prompt-schedule.event.command", { cmd: sch.command || "" })}${b.lost ? `\n${t("prompt-schedule.event.noRerun")}` : ""}\n${t("prompt-schedule.event.tail")}\n\`\`\`\n${b.text.slice(-SCHEDULE_LIMITS.tailChars)}\n\`\`\`${b.outputPath ? `\n${t("prompt-schedule.event.fullOutput", { path: b.outputPath })}` : ""}`,
    );
    return r;
  };
  // ---------------------------------------------------------- Runner routes
  deps.runner.post("/sessions/:sid/schedules", async (req: any) => {
    const s = nodeSession(req);
    const { jobId, ...body } = (req.body || {}) as any;
    return {
      schedule: create(
        s,
        body,
        "agent",
        typeof jobId === "string" && jobId.length <= 100 ? jobId : null,
      ),
    };
  });
  deps.runner.post("/sessions/:sid/schedules/list", async (req: any) => {
    const s = nodeSession(req);
    return { schedules: list(s.id) };
  });
  deps.runner.post("/sessions/:sid/schedules/:id/cancel",
    async (req: any) => {
      const s = nodeSession(req);
      return {
        schedule: cancel(s.id, req.params.id, sessionT(s)("prompt-schedule.ended.agentCanceled")),
      };
    },
  );
  deps.runner.post("/sessions/:sid/schedules/:id/event",
    async (req: any) => {
      const s = nodeSession(req),
        row = store.one(
          "SELECT * FROM agent_schedules WHERE id=? AND session_id=?",
          req.params.id,
          s.id,
        );
      const refuse = agentRefuse(s);
      if (!row) refuse(404, "prompt-schedule.error.noTask");
      if (!["bash", "monitor"].includes(row.kind)) refuse(400, "prompt-schedule.error.timerNoOutput");
      // One transaction: the throttle decision, the wake and what is kept
      // (review L2: several control-plane processes).
      return {
        ok: true,
        result: store.atomic(() =>
          event(
            s,
            store.one("SELECT * FROM agent_schedules WHERE id=?", row.id),
            req.body,
          ),
        ),
      };
    },
  );
  /**
   * The Runner's running background items (startup and every few seconds):
   * rows it no longer has were lost with a Runner restart — reported to the
   * Agent, never re-run. Answers which of its items to stop.
   */
  deps.runner.post("/schedules/sync", async (req: any) => {
    const n = deps.claimingNode(req),
      b = z
        .object({
          running: z.array(z.string().max(100)).max(1000).default([]),
          /** When this Runner process started: older rows it lacks were lost with the previous one. */
          since: z.number().int().nonnegative().default(0),
        })
        .parse(req.body ?? {});
    const have = new Set(b.running),
      now = Date.now(),
      touchedSessions = new Set<string>();
    for (const r of store.all(
      "SELECT * FROM agent_schedules WHERE node_id=? AND status='running'",
      n.id,
    )) {
      if (have.has(r.id)) continue;
      // Older than this Runner process: lost with the previous one. Newer:
      // it may be starting right now (created, not spawned yet).
      if (r.created >= b.since && r.updated > now - LOST_GRACE_MS) continue;
      store.atomic(() => {
        // Still running as read inside the transaction (review L2).
        if (
          store.one("SELECT status FROM agent_schedules WHERE id=?", r.id)
            ?.status !== "running"
        )
          return;
        const s = store.session(r.session_id);
        const t = sessionT(s);
        patch(r, "lost", { endedReason: t("prompt-schedule.ended.lost") }, null);
        touchedSessions.add(r.session_id);
        if (s && !s.archived && !s.deleting) {
          const sch = view(r),
            head = t("prompt-schedule.event.restartLost", {
              what: t(sch.kind === "bash" ? "prompt-schedule.kind.bash" : "prompt-schedule.kind.monitor"),
              label: sch.label,
            });
          // kept when it cannot wake now (queue full / budget).
          report(
            s.id,
            r.id,
            head,
            `${t("prompt-schedule.event.id", { head, id: r.id })}\n${t("prompt-schedule.event.command", { cmd: sch.command || "" })}\n${t("prompt-schedule.event.noRerun")}${sch.outputPath ? `\n${t("prompt-schedule.event.outputSoFar", { path: sch.outputPath })}` : ""}`,
          );
        }
      });
    }
    const cancel: string[] = [];
    for (const rid of have) {
      const r = store.one(
        "SELECT a.status,a.node_id,a.session_id FROM agent_schedules a WHERE a.id=?",
        rid,
      );
      const s = r && store.session(r.session_id);
      if (
        !r ||
        r.node_id !== n.id ||
        r.status !== "running" ||
        !s ||
        s.archived ||
        s.deleting ||
        residentHeld(s)
      )
        cancel.push(rid);
    }
    for (const sid of touchedSessions) refresh(sid);
    return { cancel };
  });
  // ----------------------------------------------------------- Owner routes
  const T = api.sessionTools;
  serve(app, T.scheduleList, async (req: any) => {
    const s = deps.session(req, req.params.id);
    return {
      schedules: list(s.id),
      turnsToday: turnsToday(s.id),
      // cron is read in the control plane's zone.
      timeZone: localTimeZone(),
    };
  });
  /** Only its owner changes its timers (admins read, never steer; review 2026-11-03). */
  const owned = (req: any) => {
    const s = deps.session(req, req.params.id);
    if (s.ownerId !== deps.user(req).id) ownerRefuse(req)(403, "prompt-schedule.error.notOwner");
    return s;
  };
  serve(app, T.scheduleAdd, async (req: any) => {
    const s = owned(req);
    const b = T.scheduleAdd.body.parse(req.body);
    return {
      schedule: create(s, b as ScheduleCreate, "owner", null, ownerRefuse(req), requestT(req, deps.dataDir)),
    };
  });
  /**
   * its owner changes an open timer in place (cron, prompt, label,
   * end; a one-time wake-up's time) — also one the Agent set.
   */
  serve(app, T.scheduleUpdate, async (req: any) => {
    const s = owned(req);
    const refuse = ownerRefuse(req);
    if (s.archived || s.deleting || residentHeld(s))
      refuse(409, s.resident ? "prompt-schedule.error.residentHeld" : "prompt-schedule.error.archived");
    const b = T.scheduleUpdate.body.parse(req.body);
    const now = Date.now();
    store.atomic(() => {
      const row = store.one(
        "SELECT * FROM agent_schedules WHERE id=? AND session_id=?",
        req.params.scid,
        s.id,
      );
      if (!row) refuse(404, "prompt-schedule.error.noTimer");
      if (row.status !== "active" || !["wakeup", "cron"].includes(row.kind))
        refuse(409, "prompt-schedule.error.onlyWaiting");
      const d = JSON.parse(row.data);
      let nextAt = row.next_at as number | null;
      if (b.prompt !== undefined) d.prompt = b.prompt;
      if (b.label !== undefined)
        d.label = b.label || (d.prompt || "").slice(0, 80);
      if (row.kind === "wakeup") {
        if (b.cron !== undefined || b.expiresInDays !== undefined)
          refuse(400, "prompt-schedule.error.wakeupNoCron");
        if (b.delaySeconds !== undefined) nextAt = now + b.delaySeconds * 1000;
      } else {
        if (b.delaySeconds !== undefined) refuse(400, "prompt-schedule.error.cronNoDelay");
        if (b.cron !== undefined) {
          let c;
          try {
            c = parseCron(b.cron);
          } catch (e: any) {
            return refuse(
              400,
              "prompt-schedule.error.cronInvalid",
              { why: cronWhy(requestT(req, deps.dataDir), e) },
              "cron_invalid",
            );
          }
          nextAt = nextCron(c, now);
          if (nextAt === null) refuse(400, "prompt-schedule.error.cronNever", {}, "cron_invalid");
          if (cronGap(b.cron, now) < 60_000) refuse(400, "prompt-schedule.error.cronGap", {}, "cron_invalid");
          d.cron = b.cron;
        }
        if (b.expiresInDays !== undefined && d.recurring)
          d.expiresAt = now + b.expiresInDays * DAY;
      }
      // A changed timer without a new label gets one in words (review: a
      // stale human label would describe the old time / prompt).
      if (
        b.label === undefined &&
        (b.cron !== undefined ||
          b.prompt !== undefined ||
          b.delaySeconds !== undefined)
      ) {
        // The label the Agent reads in its wakes: the session's language.
        const t = sessionT(s);
        let when = "";
        if (row.kind === "cron" && d.cron)
          try {
            when = cronText(d.cron, localTimeZone(now).offsetMinutes, undefined, t.lang);
          } catch {
            when = `cron ${d.cron}`;
          }
        d.label = (when ? t("prompt-schedule.label.when", { when, prompt: d.prompt || "" }) : d.prompt || "").slice(
          0,
          SCHEDULE_LIMITS.labelMax,
        );
      }
      d.editedAt = now;
      store.run(
        "UPDATE agent_schedules SET next_at=?,data=?,updated=? WHERE id=?",
        nextAt,
        JSON.stringify(d),
        now,
        row.id,
      );
    });
    store.audit(
      deps.user(req).id,
      "schedule.update",
      `${s.id}:${req.params.scid}`,
    );
    refresh(s.id);
    return {
      schedule: view(
        store.one("SELECT * FROM agent_schedules WHERE id=?", req.params.scid),
      ),
    };
  });
  serve(app, T.scheduleCancel, async (req: any) => {
    const s = owned(req);
    return {
      schedule: cancel(
        s.id,
        req.params.scid,
        sessionT(s)("prompt-schedule.ended.ownerCanceled"),
        ownerRefuse(req),
      ),
    };
  });
  return {
    create,
    cancel,
    cancelAll,
    pauseAll,
    resumeAll,
    hold,
    releaseHeld,
    keepCallback,
    keepStopped,
    list,
    refresh,
    tick,
    wake,
    turnsToday,
    overBudget,
    /** the session's kept reports for a turn its owner starts (taken). */
    /** R2 review N-M1: the session's kept reports go with a turn as it is claimed. */
    claimReports,
    limits,
  };
}
export type Scheduler = ReturnType<typeof schedulerRoutes>;
export type WakeResult = "queued" | "merged" | "gone" | "budget" | "full";
