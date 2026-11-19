import { z } from "zod";
import type { LiveTimer } from "./index.ts";
import { ReasoningEffortSchema, ServiceTierSchema } from "./model-options.ts";
import type { ResidentPromptConfig } from "./resident-prompt.ts";
import type { Lang } from "./i18n.ts";
import { LEGACY_PROMPT_LANG, promptT } from "./prompt-i18n.ts";
/** index.ts's TaskSchema (not imported: index.ts re-exports this module). */
const TaskSchema = z.object({
  id: z.string().min(1).max(200),
  title: z.string().min(1).max(500),
  description: z.string().max(50000).optional(),
  url: z.string().url().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
/**
 * Daisy's own scheduler: timed wake-ups, cron-like recurrence,
 * background commands and monitors that wake the Agent — for Codex (which
 * has none natively) and Claude Code (beside its native ScheduleWakeup /
 * Cron / Monitor), so 「后台 N 项」 counts one list. Timers live in the
 * control plane (they survive Runner restarts and fire into offline
 * sessions); background work runs on the session's Runner.
 */
export const SCHEDULE_KINDS = ["wakeup", "cron", "bash", "monitor"] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];
/**
 * active: a timer waiting for its time · running: a background command /
 * monitor running · done / failed: ended (exit code 0 / not 0, timed out)
 * · canceled: by the Agent or its owner (or the session closed) · expired:
 * a recurring timer past its end · lost: the Runner restarted under it
 * (never run again: no repeated side effects) · paused: a timer
 * of a paused / archived resident, kept as it was; 恢复运行 makes it
 * active again (a one-time wake-up whose time passed meanwhile expires).
 */
export type ScheduleStatus =
  | "active"
  | "running"
  | "done"
  | "failed"
  | "canceled"
  | "expired"
  | "lost"
  | "paused";
export const SCHEDULE_OPEN: readonly ScheduleStatus[] = ["active", "running"];
export const SCHEDULE_LIMITS = {
  /** Open timers (wakeup + cron) per session. */
  timers: 20,
  /** Running background commands + monitors per session (configurable on the control plane, this is the default). */
  background: 8,
  /** running background commands + monitors per node (Runner), all sessions together (default). */
  nodeBackground: 32,
  /**
   * shortest gap between two monitor wakes of one session (default);
   * a resident with a daily budget waits at least 24 h / dailyTurns. Output
   * in between is kept and delivered together.
   */
  monitorMinIntervalMs: 30_000,
  /** how long a restart waits for background work before stopping it (Runner default). */
  restartWaitMs: 30 * 60_000,
  minDelaySeconds: 60,
  maxDelaySeconds: 30 * 86400,
  /** A recurring timer ends after this many days unless told otherwise. */
  cronDefaultDays: 7,
  cronMaxDays: 30,
  backgroundDefaultSeconds: 1800,
  monitorDefaultSeconds: 3600,
  backgroundMaxSeconds: 86400,
  promptMax: 4000,
  labelMax: 300,
  commandMax: 4000,
  /** Monitor lines are batched into one wake at most this often. */
  monitorBatchMs: 2000,
  /** Lines / characters one monitor wake carries at most. */
  monitorLines: 50,
  monitorChars: 6000,
  /** Output tail sent with a background command's end. */
  tailChars: 4000,
} as const;
export interface DaisySchedule {
  id: string;
  sessionId: string;
  kind: ScheduleKind;
  status: ScheduleStatus;
  /** What it is for, in the Agent's words (or its owner's). */
  label: string;
  /** Timers: what the Agent is told when it fires. */
  prompt?: string;
  /** cron: the 5-field expression (server local time). */
  cron?: string;
  recurring?: boolean;
  /** bash / monitor: the command line, and the monitor's line filter. */
  command?: string;
  pattern?: string;
  /** Timers: next firing (ms); background: when it is stopped (timeout). */
  nextAt?: number | null;
  /** A recurring timer stops after this (ms). */
  expiresAt?: number | null;
  createdBy: "agent" | "owner";
  createdAt: number;
  updatedAt: number;
  /** Times it woke the Agent. */
  fires: number;
  lastFiredAt?: number | null;
  /** bash: exit code once ended (null = killed / timed out). */
  exitCode?: number | null;
  /** Why it ended, in words (canceled, timed out, Runner restarted…). */
  endedReason?: string;
  /** Where the Runner keeps the full output (readable by the Agent). */
  outputPath?: string;
  /**
   * a report (exit, lost, monitor output) that has not reached the
   * Agent yet — the session's queue was full, its daily budget used up, or
   * a monitor waits out its interval. Kept until delivered: by a later wake
   * (retried), or taken by the session's next turn when it is claimed.
   */
  undelivered?: ScheduleUndelivered;
}
export interface ScheduleUndelivered {
  reason: "full" | "budget" | "throttle";
  /** First report kept (ms). */
  since: number;
  /** Delivery attempts so far. */
  attempts: number;
  /** The newest report's first line. */
  head: string;
  /** Next attempt to wake the session for it (ms); the next turn claimed takes it anyway. */
  retryAt: number | null;
}
const Prompt = z.string().trim().min(1).max(SCHEDULE_LIMITS.promptMax);
const Label = z.string().trim().max(SCHEDULE_LIMITS.labelMax);
const Command = z.string().trim().min(1).max(SCHEDULE_LIMITS.commandMax);
const Seconds = (dflt: number) =>
  z
    .number()
    .int()
    .min(5)
    .max(SCHEDULE_LIMITS.backgroundMaxSeconds)
    .default(dflt);
/** What the Agent (tool) or its owner (UI) asks for. */
export const ScheduleCreateSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("wakeup"),
    delaySeconds: z
      .number()
      .int()
      .min(SCHEDULE_LIMITS.minDelaySeconds)
      .max(SCHEDULE_LIMITS.maxDelaySeconds),
    prompt: Prompt,
    reason: Label.default(""),
  }),
  z.object({
    kind: z.literal("cron"),
    cron: z.string().trim().min(9).max(100),
    prompt: Prompt,
    label: Label.default(""),
    recurring: z.boolean().default(true),
    expiresInDays: z
      .number()
      .int()
      .min(1)
      .max(SCHEDULE_LIMITS.cronMaxDays)
      .default(SCHEDULE_LIMITS.cronDefaultDays),
  }),
  z.object({
    kind: z.literal("bash"),
    command: Command,
    description: Label.default(""),
    timeoutSeconds: Seconds(SCHEDULE_LIMITS.backgroundDefaultSeconds),
  }),
  z.object({
    kind: z.literal("monitor"),
    command: Command,
    description: Label.default(""),
    timeoutSeconds: Seconds(SCHEDULE_LIMITS.monitorDefaultSeconds),
    /** Only lines matching this (JavaScript regex) wake the Agent. */
    pattern: z.string().max(200).optional(),
  }),
]);
export type ScheduleCreate = z.input<typeof ScheduleCreateSchema>;
/** PATCH /api/sessions/:id/schedules/:scid — its owner edits an open timer. */
export const ScheduleUpdateSchema = z.object({
  cron: z.string().trim().min(9).max(100).optional(),
  prompt: Prompt.optional(),
  label: Label.optional(),
  /** A one-time wake-up: fire this long from now. */
  delaySeconds: z
    .number()
    .int()
    .min(SCHEDULE_LIMITS.minDelaySeconds)
    .max(SCHEDULE_LIMITS.maxDelaySeconds)
    .optional(),
  /** A recurring timer: end this many days from now. */
  expiresInDays: z
    .number()
    .int()
    .min(1)
    .max(SCHEDULE_LIMITS.cronMaxDays)
    .optional(),
});
export type ScheduleUpdate = z.input<typeof ScheduleUpdateSchema>;
/** Runner → control plane: what happened to a background command / monitor. */
export const ScheduleEventSchema = z.object({
  type: z.enum(["output", "exit"]),
  /** output: the new lines; exit: the output's end. */
  text: z.string().max(20000).default(""),
  exitCode: z.number().int().nullable().optional(),
  /** exit: why, when not a plain exit (timed out, canceled, failed to start). */
  reason: z.string().max(300).optional(),
  outputPath: z.string().max(1000).optional(),
  /**
   * exit: the Runner stopped it because it restarts (the row
   * becomes `lost`, with the output's end; before, it was only noticed
   * after the restart, without output).
   */
  lost: z.boolean().optional(),
});
export type ScheduleEvent = z.infer<typeof ScheduleEventSchema>;

/* ---------------------------------------------------------------- cron -- */
/**
 * P6-24: a cron / template the scheduler cannot take. The text is a
 * message key (`prompt-schedule.*`) with its params, so a caller says it
 * in the language it answers in (`t.dynamic(e.key, e.params)`); `message`
 * is in `lang` (default: the language of sessions from before P6-24).
 */
export class CronError extends Error {
  constructor(
    public key: string,
    public params: Record<string, string | number> = {},
    lang: Lang = LEGACY_PROMPT_LANG,
  ) {
    super(promptT(lang).dynamic(key, params));
  }
}
const FIELDS: [number, number][] = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7], // day of week (0 and 7 = Sunday)
];
function field(part: string, [lo, hi]: [number, number], lang?: Lang): Set<number> {
  const out = new Set<number>();
  for (const piece of part.split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(piece);
    if (!m) throw new CronError("prompt-schedule.cron.unknownPiece", { piece }, lang);
    const step = m[4] ? Number(m[4]) : 1;
    let a = lo,
      b = hi;
    if (m[1] !== "*") {
      a = Number(m[2]);
      b = m[3] !== undefined ? Number(m[3]) : m[4] ? hi : a;
    }
    if (a < lo || b > hi || a > b || step < 1)
      throw new CronError("prompt-schedule.cron.outOfRange", { piece, lo, hi }, lang);
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}
export interface Cron {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  /** Day of month / week restricted (vixie cron: either matches when both are). */
  anyDay: boolean;
  anyWeekday: boolean;
}
/** A standard 5-field cron expression (minute hour day month weekday). */
export function parseCron(expr: string, lang?: Lang): Cron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new CronError("prompt-schedule.cron.fields", {}, lang);
  const [minutes, hours, days, months, weekdays] = parts.map((p, i) =>
    field(p, FIELDS[i], lang),
  );
  if (weekdays.has(7)) weekdays.add(0);
  return {
    minutes,
    hours,
    days,
    months,
    weekdays,
    anyDay: parts[2] === "*",
    anyWeekday: parts[4] === "*",
  };
}
/**
 * The first minute strictly after `after` the expression matches; null
 * within 5 years = never. `offsetMinutes` absent: this process's local
 * time (the control plane's scheduler); given: a fixed UTC offset
 * (a client previewing the server's cron, Beijing = 480).
 */
export function nextCron(
  expr: string | Cron,
  after: number,
  offsetMinutes?: number,
): number | null {
  const c = typeof expr === "string" ? parseCron(expr) : expr;
  const fixed = typeof offsetMinutes === "number",
    shift = fixed ? offsetMinutes * 60_000 : 0;
  // A fixed offset reads the shifted instant with UTC getters.
  const d = new Date(after + shift);
  const get = {
    date: () => (fixed ? d.getUTCDate() : d.getDate()),
    day: () => (fixed ? d.getUTCDay() : d.getDay()),
    month: () => (fixed ? d.getUTCMonth() : d.getMonth()),
    hours: () => (fixed ? d.getUTCHours() : d.getHours()),
    minutes: () => (fixed ? d.getUTCMinutes() : d.getMinutes()),
  };
  if (fixed) {
    d.setUTCSeconds(0, 0);
    d.setUTCMinutes(d.getUTCMinutes() + 1);
  } else {
    d.setSeconds(0, 0);
    d.setMinutes(d.getMinutes() + 1);
  }
  const dayOk = () => {
    const dom = c.days.has(get.date()),
      dow = c.weekdays.has(get.day());
    if (c.anyDay && c.anyWeekday) return true;
    if (c.anyDay) return dow;
    if (c.anyWeekday) return dom;
    return dom || dow;
  };
  for (let i = 0; i < 366 * 5; i++) {
    if (c.months.has(get.month() + 1) && dayOk()) {
      const h0 = get.hours(),
        m0 = get.minutes();
      for (let h = h0; h < 24; h++) {
        if (!c.hours.has(h)) continue;
        const from = h === h0 ? m0 : 0;
        for (let m = from; m < 60; m++)
          if (c.minutes.has(m)) {
            const at = new Date(d);
            if (fixed) at.setUTCHours(h, m, 0, 0);
            else at.setHours(h, m, 0, 0);
            const t = at.getTime() - shift;
            if (t > after) return t;
          }
      }
    }
    if (fixed) {
      d.setUTCDate(d.getUTCDate() + 1);
      d.setUTCHours(0, 0, 0, 0);
    } else {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
    }
  }
  return null;
}
/** Shortest gap between two firings over the next week (ms), to refuse sub-minute floods. */
export function cronGap(expr: string, from = Date.now()): number {
  let at = nextCron(expr, from),
    gap = Infinity;
  for (let i = 0; at !== null && i < 50; i++) {
    const n = nextCron(expr, at);
    if (n === null) break;
    gap = Math.min(gap, n - at);
    at = n;
  }
  return gap;
}

/* ------------------------------------------------------ resident Agent -- */
/**
 * 「任务常驻 Agent」: an AI private session that lives with a
 * purpose. Its thinking and tool output stay in its run log; only what it
 * sends with the `say` tool shows in its own conversation.
 */
export interface ResidentScope {
  /**
   * Tasks it may update: "bound" = every task bound to it
   * (`ResidentConfig.tasks`, following later binds / unbinds — the
   * default) · a list = only these · "all" (older records) = the bound
   * ones plus tasks its messages carried (`session.relatedTasks`).
   */
  tasks: "bound" | "all" | string[];
}
/** A task bound to a resident (several, changed later). */
export interface ResidentTask {
  id: string;
  /** Its title when known (else the id). */
  title: string;
  /** When it was bound (ms); absent on tasks migrated from `session.task`. */
  boundAt?: number;
}
export interface ResidentConfig {
  purpose: string;
  /** This session's auto-compact threshold (tokens); null = the identity's. */
  autoCompactTokens: number | null;
  /** A turn is stopped after this many minutes; null = no limit of its own. */
  maxTurnMinutes: number | null;
  /** Turns it may start by itself (timers / background) per 24 hours; null = no limit. */
  dailyTurns: number | null;
  scope: ResidentScope;
  /**
   * the tasks bound to it, in order. `session.task` stays
   * the first of them (null when none) for older clients and the task
   * pages. Absent on records from before tasks were a list: read
   * `residentTaskList()` (migrated at start-up).
   */
  tasks?: ResidentTask[];
  /** its owner's changes to the built-in prompt (see resident-prompt.ts). */
  prompt?: ResidentPromptConfig;
  /**
   * ADR-154: the name of the zone the control plane reads its cron
   * expressions in, on the copy a job carries (the Runner writes the
   * built-in prompt with it). Not stored; absent: this machine's zone.
   */
  timeZone?: string;
  createdAt: number;
  /**
   * paused by its owner (暂停), or because it was archived. No
   * turn of its own runs: its timers are held (`paused`), background work
   * ended, the process is offline, @ / messages are refused. 恢复运行
   * removes it. Archived ⇒ paused.
   */
  paused?: { at: number; reason?: string };
  /**
   * Before pausing existed: closed by its owner (final). Migrated at start-up to
   * `paused` (+ archived); kept only on records an older server wrote.
   */
  closed?: { at: number; reason: string };
}
/**
 * the one state model of a resident — 运行中 / 已暂停 / 已归档
 * (deleted residents no longer exist). Archived wins; a legacy `closed`
 * reads as paused.
 */
export type ResidentState = "running" | "paused" | "archived";
export function residentState(s: {
  archived?: boolean;
  resident?: Pick<ResidentConfig, "paused" | "closed"> | null;
}): ResidentState {
  if (s.archived) return "archived";
  return s.resident?.paused || s.resident?.closed ? "paused" : "running";
}
/** nothing of its own runs (paused, archived, or legacy closed). */
export function residentHeld(s: {
  kind?: string;
  archived?: boolean;
  resident?: Pick<ResidentConfig, "paused" | "closed"> | null;
}): boolean {
  return (
    !!s.resident && (!!s.archived || !!s.resident.paused || !!s.resident.closed)
  );
}
/**
 * the 409 a paused / archived resident answers to its owner's
 * messages and commands (`code: "resident_paused"`). Says where to resume:
 * an older App has no 恢复运行 (review L4).
 */
export const RESIDENT_PAUSED_CODE = "resident_paused";
/** P6-24: its words, a message key (`LocalizedError(409, RESIDENT_PAUSED_CODE, RESIDENT_PAUSED_KEY)`). */
export const RESIDENT_PAUSED_KEY = "prompt-schedule.residentPaused" as const;
/** the words for each state (UI, notices): message keys. */
export const RESIDENT_STATE_KEY = {
  running: "prompt-schedule.residentState.running",
  paused: "prompt-schedule.residentState.paused",
  archived: "prompt-schedule.residentState.archived",
} as const satisfies Record<ResidentState, string>;
/** The bound tasks of a resident, also for records from before (their `session.task`). */
export function residentTaskList(s: {
  task?: { id: string; title?: string } | null;
  resident?: Pick<ResidentConfig, "tasks"> | null;
}): ResidentTask[] {
  if (Array.isArray(s.resident?.tasks)) return s.resident!.tasks!;
  return s.task?.id
    ? [{ id: s.task.id, title: s.task.title || s.task.id }]
    : [];
}
export const RESIDENT_LIMITS = {
  purposeMax: 4000,
  reasonMax: 1000,
  maxTurnMinutes: 24 * 60,
  dailyTurns: 1000,
  scopeIds: 100,
  /** bound tasks per resident. */
  tasks: 20,
  /** Claude Code's --autocompact range, also Codex's sane window. */
  compact: [20_000, 1_000_000] as [number, number],
} as const;
const Ids = z
  .array(z.string().trim().min(1).max(200))
  .max(RESIDENT_LIMITS.scopeIds);
/** A task to bind: its id, or id and title. */
export const ResidentTaskRefSchema = z.union([
  z.string().trim().min(1).max(200),
  z.object({
    id: z.string().trim().min(1).max(200),
    title: z.string().trim().max(500).optional(),
  }),
]);
/** POST /api/sessions/:id/resident/tasks — bind / unbind. */
export const ResidentTasksUpdateSchema = z.object({
  add: z.array(ResidentTaskRefSchema).max(RESIDENT_LIMITS.tasks).default([]),
  remove: z
    .array(z.string().trim().min(1).max(200))
    .max(RESIDENT_LIMITS.tasks)
    .default([]),
});
export type ResidentTasksUpdate = z.input<typeof ResidentTasksUpdateSchema>;
export const ResidentScopeSchema = z.object({
  tasks: z.union([z.enum(["bound", "all"]), Ids]).default("bound"),
});
/** The controls (wizard and later changes). */
export const ResidentControlsSchema = z.object({
  autoCompactTokens: z
    .number()
    .int()
    .min(RESIDENT_LIMITS.compact[0])
    .max(RESIDENT_LIMITS.compact[1])
    .nullable()
    .optional(),
  maxTurnMinutes: z
    .number()
    .int()
    .min(1)
    .max(RESIDENT_LIMITS.maxTurnMinutes)
    .nullable()
    .optional(),
  dailyTurns: z
    .number()
    .int()
    .min(1)
    .max(RESIDENT_LIMITS.dailyTurns)
    .nullable()
    .optional(),
  scope: ResidentScopeSchema.optional(),
  purpose: z.string().trim().min(1).max(RESIDENT_LIMITS.purposeMax).optional(),
});
export type ResidentControls = z.input<typeof ResidentControlsSchema>;
/** The wizard's first schedule: none, every N minutes, a cron, or once after N minutes. */
export const ResidentScheduleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({
    kind: z.literal("every"),
    minutes: z
      .number()
      .int()
      .min(1)
      .max(7 * 24 * 60),
    prompt: z.string().trim().max(SCHEDULE_LIMITS.promptMax).default(""),
    expiresInDays: z
      .number()
      .int()
      .min(1)
      .max(SCHEDULE_LIMITS.cronMaxDays)
      .default(SCHEDULE_LIMITS.cronMaxDays),
  }),
  z.object({
    kind: z.literal("cron"),
    cron: z.string().trim().min(9).max(100),
    prompt: z.string().trim().max(SCHEDULE_LIMITS.promptMax).default(""),
    expiresInDays: z
      .number()
      .int()
      .min(1)
      .max(SCHEDULE_LIMITS.cronMaxDays)
      .default(SCHEDULE_LIMITS.cronMaxDays),
  }),
  z.object({
    kind: z.literal("once"),
    minutes: z
      .number()
      .int()
      .min(1)
      .max(30 * 24 * 60),
    prompt: z.string().trim().max(SCHEDULE_LIMITS.promptMax).default(""),
  }),
]);
/** POST /api/residents — the wizard. */
export const CreateResidentSchema = z.object({
  requestId: z.string().min(8).max(100),
  title: z.string().trim().max(200).default(""),
  purpose: z.string().trim().min(1).max(RESIDENT_LIMITS.purposeMax),
  profileId: z.string().min(1).max(100),
  workspaceId: z.string().min(1).max(100),
  workspaceMode: z.enum(["shared", "isolated"]).default("shared"),
  /** A task (id, or the full context a host knows), or none. */
  task: z.union([TaskSchema, z.string().trim().min(1).max(200)]).optional(),
  /** several tasks (with `task`, the first is `session.task`). */
  tasks: z.array(ResidentTaskRefSchema).max(RESIDENT_LIMITS.tasks).optional(),
  model: z.string().max(200).default(""),
  /** this conversation's effort / Codex speed (empty = the identity's). */
  reasoningEffort: ReasoningEffortSchema.default(""),
  serviceTier: ServiceTierSchema.default(""),
  controls: ResidentControlsSchema.default({}),
  schedule: ResidentScheduleSchema.default({ kind: "none" }),
  /** Start working right away (a first turn with the purpose). */
  startNow: z.boolean().default(true),
});
export type CreateResident = z.input<typeof CreateResidentSchema>;
/**
 * Before pausing existed: 关闭 needed the owner's reason. Still accepted
 * (older clients): it now pauses and archives (reversible).
 */
export const CloseResidentSchema = z.object({
  reason: z.string().trim().min(2).max(RESIDENT_LIMITS.reasonMax),
});
/** 暂停 — a reason is optional (shown on its strip). */
export const PauseResidentSchema = z.object({
  reason: z.string().trim().max(RESIDENT_LIMITS.reasonMax).default(""),
});
/** GET /api/sessions/:id/resident — what it is doing (the close dialog). */
export interface ResidentStatus {
  sessionId: string;
  resident: ResidentConfig;
  online: boolean;
  busy: boolean;
  status: string;
  /** Daisy timers and background work still open. */
  schedules: DaisySchedule[];
  /** Native timers / background tasks of the online process (Claude Code). */
  native: LiveTimer[];
  /** Its last message to people (say), if any. */
  lastSaid: { text: string; at: number } | null;
  /** Turns it started by itself in the last 24 hours (the budget). */
  turnsToday: number;
  /** its bound tasks (also for records from before). */
  tasks?: ResidentTask[];
  /** tasks its messages carried (candidates for 「只这些任务」). */
  relatedTasks?: { id: string; title: string }[];
  /** the zone its cron expressions are read in (the control plane's). */
  timeZone?: ServerTimeZone;
}
/** Item id marker of a resident's message to people (`<job>:say:<n>`). */
export const SAY_CATEGORY = "say" as const;
/** What the resident's conversation shows by default: people's words and its `say`. */
export function residentVisible(item: {
  kind: string;
  category?: string;
  id: string;
}): boolean {
  if (item.kind === "user") return true;
  // 已暂停 / 已恢复运行 / 已归档 notices show there too.
  if (item.id.startsWith("resident-state:")) return true;
  return item.category === SAY_CATEGORY;
}
/** "every N minutes" as a cron expression (N ≥ 60 must divide a day evenly into hours). */
/**
 * 「每 N 分钟」 as cron. Only intervals cron repeats evenly (review
 * 2026-11-03: `*\/7` fires at :56 and again at :00): minutes dividing an
 * hour, hours dividing a day, or once a day.
 */
export function everyCron(minutes: number, lang?: Lang): string {
  if (minutes < 60 && 60 % minutes === 0) return `*/${minutes} * * * *`;
  if (minutes % 60 === 0 && minutes < 24 * 60 && (24 * 60) % minutes === 0)
    return `0 */${minutes / 60} * * *`;
  if (minutes === 24 * 60) return "0 9 * * *";
  throw new CronError("prompt-schedule.every.uneven", {}, lang);
}

/* ------------------------------------------- cron for people -- */
/**
 * Where the control plane reads cron expressions (its local time). ADR-154
 * (D-43): it is also the zone people's times are written in — the
 * machine's own, named in the text — where they were Beijing time before.
 */
export interface ServerTimeZone {
  /** IANA name when known ("UTC", "Europe/Berlin"). */
  name: string;
  /** Minutes east of UTC now (UTC+8: 480). */
  offsetMinutes: number;
}
/** This process's zone (the control plane calls it for its lists). */
export function localTimeZone(at = Date.now()): ServerTimeZone {
  let name = "";
  try {
    name = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {}
  const offsetMinutes = -new Date(at).getTimezoneOffset() || 0;
  return { name: name || utcLabel(offsetMinutes), offsetMinutes };
}
const pad = (n: number) => String(n).padStart(2, "0");
const utcLabel = (off: number) =>
  off === 0
    ? "UTC"
    : `UTC${off > 0 ? "+" : "-"}${pad(Math.floor(Math.abs(off) / 60))}${Math.abs(off) % 60 ? ":" + pad(Math.abs(off) % 60) : ""}`;
/** The zone as text names it: its IANA name, else 「UTC+08:00」. */
export function zoneName(tz: ServerTimeZone = localTimeZone()): string {
  return tz.name || utcLabel(tz.offsetMinutes);
}
/** A day of the week (0 = Sunday) in words: 「一」 / "Mon". */
const weekday = (t: ReturnType<typeof promptT>, d: number) => t.dynamic(`prompt-schedule.weekday.${d}`);
/** One instant in a fixed offset: { md: "11-05", week: "周四", hm: "09:00" }. */
export function zoned(ms: number, offsetMinutes: number, lang: Lang = LEGACY_PROMPT_LANG) {
  const d = new Date(ms + offsetMinutes * 60_000);
  const t = promptT(lang);
  return {
    md: `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    week: t("prompt-schedule.week", { day: weekday(t, d.getUTCDay()) }),
    hm: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
    ymd: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
  };
}
/**
 * 「11-05 周四 09:00（Asia/Shanghai）· 01:00 UTC」 in the machine's zone
 * (the UTC day when it differs; no second time when the zone is UTC).
 */
export function bothTimes(
  ms: number,
  tz: ServerTimeZone = localTimeZone(ms),
  lang: Lang = LEGACY_PROMPT_LANG,
) {
  const t = promptT(lang);
  const b = zoned(ms, tz.offsetMinutes, lang),
    u = zoned(ms, 0, lang);
  const here = t("prompt-schedule.both.here", { md: b.md, week: b.week, hm: b.hm, zone: zoneName(tz) });
  return tz.offsetMinutes === 0
    ? here
    : t("prompt-schedule.both.utc", { here, day: u.md !== b.md ? `${u.md} ` : "", hm: u.hm });
}
/** The next `n` firings (ms) after `after`, read in the server's zone. */
export function cronRuns(
  expr: string,
  after: number,
  n: number,
  serverOffset: number,
): number[] {
  const out: number[] = [];
  const c = parseCron(expr);
  let at: number | null = after;
  while (out.length < n && at !== null) {
    at = nextCron(c, at, serverOffset);
    if (at !== null) out.push(at);
  }
  return out;
}
/**
 * The common schedules people pick, with the time of day in the
 * server's zone (ADR-154: was Beijing time): every N minutes, every N
 * hours, every day, weekdays, some weekdays; anything else is a cron
 * expression (advanced).
 */
export type CronTemplate =
  | { kind: "minutes"; every: number }
  | { kind: "hours"; every: number; minute: number }
  | { kind: "daily"; time: string }
  | { kind: "weekdays"; time: string }
  | { kind: "weekly"; days: number[]; time: string }
  | { kind: "cron"; cron: string };
/** Intervals cron repeats evenly (see everyCron). */
export const EVERY_MINUTES = [1, 2, 3, 5, 10, 15, 20, 30] as const;
export const EVERY_HOURS = [1, 2, 3, 4, 6, 8, 12] as const;
const hm = (t: string, lang?: Lang) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59)
    throw new CronError("prompt-schedule.template.time", {}, lang);
  return Number(m[1]) * 60 + Number(m[2]);
};
const listOf = (xs: number[]) => {
  const v = [...new Set(xs)].sort((a, b) => a - b);
  // Contiguous runs as a-b (1-5), else a list.
  if (v.length > 2 && v.every((x, i) => i === 0 || x === v[i - 1] + 1))
    return `${v[0]}-${v[v.length - 1]}`;
  return v.join(",");
};
/**
 * A template as a cron expression in the server's zone (its time of day is
 * the server's own: ADR-154). `serverOffset` is kept for callers; the
 * template and the expression are in the same zone, so it moves nothing.
 */
export function templateCron(t: CronTemplate, _serverOffset?: number, lang?: Lang): string {
  if (t.kind === "cron") return t.cron.trim();
  if (t.kind === "minutes") {
    if (!(EVERY_MINUTES as readonly number[]).includes(t.every))
      throw new CronError("prompt-schedule.template.minutes", {}, lang);
    return t.every === 1 ? "* * * * *" : `*/${t.every} * * * *`;
  }
  if (t.kind === "hours") {
    if (!(EVERY_HOURS as readonly number[]).includes(t.every))
      throw new CronError("prompt-schedule.template.hours", {}, lang);
    const minute = Math.max(0, Math.min(59, Math.floor(t.minute)));
    // Every N hours counted from the server's midnight.
    return t.every === 1 ? `${minute} * * * *` : `${minute} */${t.every} * * *`;
  }
  const mins = hm(t.time, lang);
  const at = `${mins % 60} ${Math.floor(mins / 60)}`;
  if (t.kind === "daily") return `${at} * * *`;
  const days = t.kind === "weekdays" ? [1, 2, 3, 4, 5] : t.days;
  if (!days.length) throw new CronError("prompt-schedule.template.noDay", {}, lang);
  return `${at} * * ${listOf(days)}`;
}
/** The template a cron expression is (for editing), else {kind: "cron"}. */
export function cronTemplateOf(
  cron: string,
  _serverOffset?: number,
): CronTemplate {
  const raw = { kind: "cron" as const, cron };
  let c: Cron;
  try {
    c = parseCron(cron);
  } catch {
    return raw;
  }
  for (const t of candidates(c))
    if (sameCron(templateCron(t), cron)) return t;
  return raw;
}
function candidates(c: Cron): CronTemplate[] {
  const out: CronTemplate[] = [];
  for (const every of EVERY_MINUTES) out.push({ kind: "minutes", every });
  const minute = c.minutes.size === 1 ? [...c.minutes][0] : 0;
  for (const every of EVERY_HOURS) out.push({ kind: "hours", every, minute });
  if (c.minutes.size === 1 && c.hours.size === 1) {
    const mins = [...c.hours][0] * 60 + minute;
    const time = `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
    out.push({ kind: "daily", time }, { kind: "weekdays", time });
    if (!c.anyWeekday) {
      const days = [...c.weekdays].filter((d) => d !== 7);
      out.push({ kind: "weekly", days: [...new Set(days)].sort(), time });
    }
  }
  return out;
}
const sameCron = (a: string, b: string) => {
  try {
    const x = parseCron(a),
      y = parseCron(b);
    const eq = (p: Set<number>, q: Set<number>) =>
      p.size === q.size && [...p].every((v) => q.has(v));
    return (
      eq(x.minutes, y.minutes) &&
      eq(x.hours, y.hours) &&
      eq(x.days, y.days) &&
      eq(x.months, y.months) &&
      eq(x.weekdays, y.weekdays) &&
      x.anyDay === y.anyDay &&
      x.anyWeekday === y.anyWeekday
    );
  } catch {
    return false;
  }
};
/**
 * A cron expression in words, times in the server's zone, named
 * (ADR-154: was Beijing time): 「每 30 分钟」, 「每天 09:00（Asia/Shanghai）·
 * UTC 01:00」, 「工作日（周一至周五）09:00（UTC）」; otherwise
 * 「自定义：<cron>（按服务器时区 X）」. `zone`: the zone's name (default:
 * this process's, when its offset is `serverOffset`; else 「UTC±hh:mm」).
 */
export function cronText(
  cron: string,
  serverOffset: number,
  zone?: string,
  lang: Lang = LEGACY_PROMPT_LANG,
): string {
  const w = promptT(lang);
  const here = localTimeZone();
  const name =
    zone || (here.offsetMinutes === serverOffset ? zoneName(here) : utcLabel(serverOffset));
  const t = cronTemplateOf(cron, serverOffset);
  if (t.kind === "minutes")
    return t.every === 1
      ? w("prompt-schedule.cronText.minute")
      : w("prompt-schedule.cronText.minutes", { n: t.every });
  if (t.kind === "hours")
    return t.every === 1
      ? w("prompt-schedule.cronText.hour", { minute: t.minute })
      : w("prompt-schedule.cronText.hours", { n: t.every, minute: t.minute });
  if (t.kind === "cron") return w("prompt-schedule.cronText.custom", { cron, zone: name });
  const utc = hm(t.time, lang) - serverOffset,
    u = ((utc % 1440) + 1440) % 1440,
    utcDay =
      utc < 0
        ? w("prompt-schedule.cronText.dayBefore")
        : utc >= 1440
          ? w("prompt-schedule.cronText.dayAfter")
          : "";
  const tail =
    w("prompt-schedule.cronText.at", { time: t.time, zone: name }) +
    (serverOffset === 0
      ? ""
      : w("prompt-schedule.cronText.utc", { day: utcDay, hm: `${pad(Math.floor(u / 60))}:${pad(u % 60)}` }));
  if (t.kind === "daily") return w("prompt-schedule.cronText.daily", { tail });
  if (t.kind === "weekdays") return w("prompt-schedule.cronText.weekdays", { tail });
  return w("prompt-schedule.cronText.weekly", {
    days: t.days.map((d) => weekday(w, d)).join(w("prompt-schedule.listSep")),
    tail,
  });
}
