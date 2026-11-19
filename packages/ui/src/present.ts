import {
  agentShortName,
  isAcpAgent,
  isSchedulerItem,
  normalizeLiveTimer,
  schedulerPendingOf,
} from "@daisy-ai/contracts";
import type {
  Agent,
  CacheCounters,
  ContextThreshold,
  Item,
  LiveTimer,
  QuotaSnapshot,
  Session,
} from "@daisy-ai/contracts";
import { interpolate, isSystemSender, PRODUCT_NAME } from "@daisy-ai/contracts";
import { t } from "./i18n";
/**
 * Presentation helpers with no React Native dependency (unit-tested in
 * tests/present.test.ts): host link validation, phase tones, time formats.
 */

/**
 * Resolve a link the host gave us (branding `hostUrl`, a session's
 * `task.url`) for top-level navigation. Only http(s); relative links resolve
 * against `here` (the page origin); the result must be same-origin with
 * `here` or listed in `origins` (DAISY_ORIGINS, from /api/health
 * `hostOrigins`). Anything else (javascript:, data:, other sites, malformed,
 * control characters, backslashes) yields null.
 */
export function safeHostHref(
  raw: string | undefined | null,
  here: string,
  origins: readonly string[] = [],
): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value || value.length > 2000 || /[\u0000-\u001f\u007f\\]/.test(value))
    return null;
  let base: URL, url: URL;
  try {
    base = new URL(here);
    url = new URL(value, base.origin + "/");
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.origin !== base.origin && !origins.includes(url.origin)) return null;
  return url.href;
}

/** Colour role of a lifecycle phase; the same everywhere a status is shown. */
export type DaisyPhaseTone =
  "success" | "neutral" | "danger" | "warning" | "accent";
export function daisyPhaseTone(phase: string): DaisyPhaseTone {
  switch (phase) {
    case "completed":
      return "success";
    case "idle":
    case "interrupted":
      return "neutral";
    case "failed":
      return "danger";
    case "awaiting-authorization":
      return "warning";
    default:
      return "accent"; // queued, running
  }
}

/** Time / date formatting options: host `lang` and 12/24-hour clock. */
export interface DaisyTimeOptions {
  /** BCP 47 locale (branding `lang`); undefined = the browser's. */
  locale?: string;
  /** 12-hour clock; undefined = false for Chinese, else the locale default. */
  hour12?: boolean;
}
export function daisyTimeFormat(
  { locale, hour12 }: DaisyTimeOptions = {},
  // ADR-159: the UI's language (a host's `lang` still wins).
  fallbackLocale: string | undefined = t.lang,
) {
  const effective = locale || fallbackLocale;
  const h12 = hour12 ?? (/^zh\b/i.test(effective || "") ? false : undefined);
  const loc = effective ? [effective] : undefined;
  const clock = h12 === undefined ? {} : { hour12: h12 };
  const safe = (fn: () => string, ts: number) => {
    try {
      return fn();
    } catch {
      return new Date(ts).toISOString();
    }
  };
  return {
    /** 15:42 (or 03:42 PM with a 12-hour clock). */
    time: (ts: number) =>
      safe(
        () =>
          new Date(ts).toLocaleTimeString(loc, {
            hour: "2-digit",
            minute: "2-digit",
            ...clock,
          }),
        ts,
      ),
    /** 2026/10/10 in zh-CN. */
    date: (ts: number) =>
      safe(
        () =>
          new Date(ts).toLocaleDateString(loc, {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }),
        ts,
      ),
  };
}

/**
 * Fill `{name}` placeholders of a copy string; a plural choice
 * (`{count, plural, one {# step} other {# steps}}`, P6-28) takes the
 * UI language's plural rules.
 */
export function fillCopy(
  template: string,
  values: Record<string, string | number>,
) {
  return interpolate(template, values, t.lang);
}
/** The shell command a tool call / authorization request runs, if any. */
export function commandOf(input: unknown): string {
  const v = (input as any)?.command ?? (input as any)?.cmd;
  const s = Array.isArray(v)
    ? v.map(String).join(" ")
    : typeof v === "string"
      ? v
      : "";
  return s.replace(/\s+/g, " ").trim();
}
const short = (s: string, n = 40) =>
  s.length > n ? s.slice(0, n - 1) + "…" : s;
const DENIED = /deny|decline|reject|cancel|abort/i;
/** Wording used by `turnActions` (a subset of DaisyCopy). */
export interface TurnCopy {
  traceRanCommand: string;
  traceWantedCommand: string;
  traceToolDetail: string;
  traceApprovalNote: string;
  traceApprovalDenied: string;
  traceApprovalExpired: string;
}
interface ToolLike {
  name?: string;
  input?: unknown;
}
interface DecisionLike {
  title: string;
  input: unknown;
  status: string;
  options: { id: string; label: string }[];
  decision?: { optionId: string };
}
/**
 * One readable line per thing the Agent did in a turn (fb3 review r2 N5):
 * 「运行了 pwd（允许本次）」. Tool calls and the tool authorizations decided
 * in the same turn are merged (same command, or an unnamed tool paired with
 * the next authorization), so a command never shows twice.
 */
export function turnActions<T extends ToolLike>(
  tools: readonly T[],
  approvals: readonly DecisionLike[],
  copy: TurnCopy,
  toolName: (t: T) => string,
): string[] {
  const left = [...approvals];
  const note = (a: DecisionLike | undefined) => {
    if (!a) return { text: "", refused: false };
    if (a.status === "expired")
      return { text: copy.traceApprovalExpired, refused: true };
    if (DENIED.test(a.decision?.optionId || ""))
      return { text: copy.traceApprovalDenied, refused: true };
    const option = a.options.find((o) => o.id === a.decision?.optionId);
    return {
      text: option
        ? fillCopy(copy.traceApprovalNote, { option: option.label })
        : "",
      refused: false,
    };
  };
  const phrase = (
    cmd: string,
    name: string,
    input: unknown,
    refused: boolean,
  ) => {
    if (cmd)
      return fillCopy(
        refused ? copy.traceWantedCommand : copy.traceRanCommand,
        {
          command: short(cmd),
        },
      );
    const i = input as any;
    const detail = String(
      i?.file_path ?? i?.path ?? i?.url ?? i?.pattern ?? "",
    );
    return detail
      ? fillCopy(copy.traceToolDetail, {
          tool: name,
          detail: short(detail, 30),
        })
      : name;
  };
  const out: string[] = [];
  for (const t of tools) {
    const cmd = commandOf(t.input);
    const named = !!(t.name || t.input !== undefined);
    const at = left.findIndex((a) =>
      cmd ? commandOf(a.input) === cmd : !named,
    );
    const a = at >= 0 ? left.splice(at, 1)[0] : undefined;
    if (!named && !a) continue;
    const n = note(a);
    out.push(
      phrase(
        cmd || commandOf(a?.input),
        named ? toolName(t) : a!.title,
        named ? t.input : a!.input,
        n.refused,
      ) + n.text,
    );
  }
  for (const a of left) {
    const n = note(a);
    out.push(phrase(commandOf(a.input), a.title, a.input, n.refused) + n.text);
  }
  return out;
}
/** Latest context fill of a conversation, or null before any is reported. */
export function contextFill(items: Item[]) {
  let used: number | null = null,
    window: number | null = null;
  for (let i = items.length - 1; i >= 0; i--) {
    const x = items[i];
    if (x.category !== "usage" || !x.id.endsWith(":context")) continue;
    const v = x.input as { used?: number; window?: number | null } | undefined;
    if (used === null && typeof v?.used === "number") used = v.used;
    if (window === null && v?.window) window = v.window;
    if (used !== null && window !== null) break;
  }
  return used !== null && window ? { used, window } : null;
}
/** Token count for the ring and bubble: 167000 → "167K", 1000000 → "1M". */
export function kTokens(n: number) {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m >= 10 || Number.isInteger(m) ? Math.round(m) : m.toFixed(1)}M`;
  }
  if (n >= 1000) {
    const k = n / 1000;
    return `${k >= 100 || Number.isInteger(k) ? Math.round(k) : k.toFixed(1)}K`;
  }
  return String(Math.round(n));
}
/**
 * The composer's context ring: used / the Agent's real
 * auto-compact trigger point. Nothing else is ever the denominator — not
 * the model window, not a fixed number: without a reported trigger point
 * (unknown, auto-compact off, an older Runner, no data yet) the ring is
 * 「不可用」 with the reason.
 */
export interface ContextGauge {
  available: boolean;
  /** used / trigger × 100, rounded (may pass 100); null when unavailable. */
  percent: number | null;
  /** 0–1 for drawing the arc. */
  fill: number;
  /** normal < 70 % ≤ warning < 90 % ≤ danger; muted = unavailable. */
  tone: "normal" | "warning" | "danger" | "muted";
  /** What the ring shows: 「34%」「≈34%」「≥100%」「—」. */
  text: string;
  /** Why it is unavailable / a caveat (shown in the bubble). */
  reason?: string;
  used: number | null;
  trigger: number | null;
  /** Past the trigger point: compaction did not happen (yet). */
  over: boolean;
  exact: boolean;
}
export function contextGauge(
  session: Pick<Session, "context"> | null | undefined,
  items: readonly Item[] = [],
): ContextGauge {
  const none = (reason: string): ContextGauge => ({
    available: false,
    percent: null,
    fill: 0,
    tone: "muted",
    text: "—",
    reason,
    used: c?.used ?? null,
    trigger: null,
    over: false,
    exact: true,
  });
  const c = session?.context;
  if (!c || c.v !== 1) {
    const legacy = items.some(
      (x) => x.category === "usage" && x.id.endsWith(":context"),
    );
    return none(
      legacy ? t("ui-present.gauge.legacy") : t("ui-present.gauge.noData"),
    );
  }
  const th = c.threshold;
  if (
    th.tokens === null ||
    !(th.tokens > 0) ||
    (th.source !== "harness" && th.source !== "config")
  )
    return none(
      th.reason ||
        (th.enabled === false
          ? t("ui-present.gauge.off")
          : t("ui-present.gauge.noThreshold")),
    );
  const percent = Math.round((c.used / th.tokens) * 100);
  const over = c.used >= th.tokens;
  return {
    available: true,
    percent,
    fill: Math.max(0, Math.min(1, c.used / th.tokens)),
    tone: percent >= 90 ? "danger" : percent >= 70 ? "warning" : "normal",
    text: over ? "≥100%" : `${th.exact ? "" : "≈"}${percent}%`,
    ...(over
      ? { reason: t("ui-present.gauge.over") }
      : th.reason
        ? { reason: th.reason }
        : {}),
    used: c.used,
    trigger: th.tokens,
    over,
    exact: th.exact,
  };
}
/** Cache hit rate = Σ cache read / Σ prompt tokens (cached included); null = no data. */
export function cacheRate(c: CacheCounters | null | undefined) {
  return c && c.prompt > 0 ? c.read / c.prompt : null;
}
/** One line of the ring's bubble (R2 a–e). */
export interface BubbleRow {
  key: "plan" | "weekly" | "five_hour" | "cache" | "context";
  label: string;
  value: string;
  /** Small print under the value. */
  note?: string;
  unavailable?: boolean;
}
const pct = (n: number) => `${Math.round(n)}%`;
/** Who set the auto-compact point, as people read it. */
const ORIGIN_KEYS = {
  identity: "ui-present.origin.identity",
  "cli-default": "ui-present.origin.cliDefault",
  "cli-env": "ui-present.origin.cliEnv",
  "cli-settings": "ui-present.origin.cliSettings",
  unknown: "ui-present.origin.unknown",
} as const;
/**
 * The ring's bubble (R2): plan, weekly and 5-hour remaining,
 * cache hit rate, context. Anything not known says 「不可用」 and why — no
 * value is ever made up. `hidden`: the viewer is not the conversation's
 * owner (quota is the owner's).
 */
export function contextBubble(
  session:
    | (Pick<Session, "context" | "quota" | "agent"> & { quotaHidden?: boolean })
    | null
    | undefined,
  items: readonly Item[] = [],
  now = Date.now(),
  formatTime: (ms: number) => string = (ms) =>
    new Date(ms).toLocaleString(t.lang, {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }),
): BubbleRow[] {
  const rows: BubbleRow[] = [];
  const q: QuotaSnapshot | undefined = session?.quota;
  const hidden = !!session?.quotaHidden;
  const na = t("ui-present.na");
  const stale = q ? t("ui-present.bubble.updated", { ago: agoText(now - q.fetchedAt) }) : "";
  const ownerOnly = t("ui-present.bubble.ownerOnly");
  if (hidden || !q)
    rows.push({
      key: "plan",
      label: t("ui-present.bubble.plan"),
      value: na,
      note: hidden ? ownerOnly : t("ui-present.bubble.planNoData"),
      unavailable: true,
    });
  else
    rows.push({
      key: "plan",
      label: t("ui-present.bubble.plan"),
      value: q.plan.name
        ? `${q.plan.name}${q.identity && q.identity !== q.plan.name ? ` · ${q.identity}` : ""}`
        : na,
      ...(q.plan.name
        ? q.plan.source === "identity-label"
          ? { note: t("ui-present.bubble.planFromLabel") }
          : {}
        : { note: q.reason || t("ui-present.bubble.planNone"), unavailable: true }),
    });
  const windowRow = (key: "weekly" | "five_hour", label: string): BubbleRow => {
    if (hidden)
      return { key, label, value: na, note: ownerOnly, unavailable: true };
    if (!q)
      return {
        key,
        label,
        value: na,
        note: t("ui-present.bubble.noData"),
        unavailable: true,
      };
    const w = q.windows.find((x) => x.kind === key);
    if (q.status !== "ok" || !w || w.usedPercent === null)
      return {
        key,
        label,
        value: na,
        note:
          q.status !== "ok"
            ? q.reason || t("ui-present.bubble.quotaFailed")
            : t("ui-present.bubble.notReported"),
        unavailable: true,
      };
    const reset =
      w.resetsAt === null
        ? ""
        : w.resetsAt < now
          ? t("ui-present.bubble.resetPending")
          : t("ui-present.bubble.resets", { time: formatTime(w.resetsAt) });
    return {
      key,
      label,
      value: t("ui-present.bubble.left", { pct: pct(Math.max(0, 100 - w.usedPercent)) }),
      note: [reset, t("ui-present.bubble.noAbsolute"), stale].filter(Boolean).join(" · "),
    };
  };
  rows.push(windowRow("weekly", t("ui-present.bubble.weekly")));
  rows.push(windowRow("five_hour", t("ui-present.bubble.fiveHour")));
  const c = session?.context?.v === 1 ? session.context : undefined;
  const whole = cacheRate(c?.cacheSession),
    turn = cacheRate(c?.cache);
  rows.push(
    whole === null
      ? {
          key: "cache",
          label: t("ui-present.bubble.cache"),
          value: na,
          note:
            isAcpAgent(session?.agent)
              ? t("ui-present.bubble.cacheNotReported", { agent: agentShortName(session!.agent) })
              : t("ui-present.bubble.noData"),
          unavailable: true,
        }
      : {
          key: "cache",
          label: t("ui-present.bubble.cache"),
          value: pct(whole * 100),
          note:
            turn === null
              ? t("ui-present.bubble.cacheNote", {
                  read: kTokens(c!.cacheSession!.read),
                  prompt: kTokens(c!.cacheSession!.prompt),
                })
              : t("ui-present.bubble.cacheNoteTurn", {
                  turn: pct(turn * 100),
                  read: kTokens(c!.cacheSession!.read),
                  prompt: kTokens(c!.cacheSession!.prompt),
                }),
        },
  );
  const g = contextGauge(session, items);
  const th = c?.threshold;
  const notes: string[] = [];
  if (th && g.available) {
    const codex = session?.agent === "codex";
    notes.push(
      t("ui-present.bubble.threshold", {
        source: codex
          ? th.origin === "cli-default"
            ? t("ui-present.bubble.sourceCodexDefault")
            : t("ui-present.bubble.sourceCodexLimit")
          : t("ui-present.bubble.sourceClaude"),
        window:
          th.window && th.window !== th.tokens
            ? t(codex ? "ui-present.bubble.windowLimit" : "ui-present.bubble.windowCompact", {
                k: kTokens(th.window),
              })
            : "",
        origin: t(ORIGIN_KEYS[th.origin] ?? "ui-present.origin.unknown"),
      }),
    );
  }
  if (g.reason) notes.push(g.reason);
  if (c?.window) notes.push(t("ui-present.bubble.modelWindow", { k: kTokens(c.window) }));
  if (c?.lastCompact) {
    const l = c.lastCompact;
    notes.push(
      t("ui-present.bubble.lastCompact", {
        pre: l.preTokens !== undefined ? kTokens(l.preTokens) : "?",
        post: l.postTokens !== undefined ? kTokens(l.postTokens) : "?",
        trigger:
          l.trigger === "auto"
            ? t("ui-present.compact.auto")
            : l.trigger === "manual"
              ? t("ui-present.compact.manual")
              : t("ui-present.compact.other"),
        ago: agoText(now - l.at),
      }),
    );
  }
  rows.push({
    key: "context",
    label: t("ui-present.bubble.context"),
    value: g.available
      ? t("ui-present.bubble.contextValue", { used: kTokens(g.used!), trigger: kTokens(g.trigger!), text: g.text })
      : na,
    ...(notes.length ? { note: notes.join("\n") } : {}),
    ...(g.available ? {} : { unavailable: true }),
  });
  return rows;
}
/** `GET /api/profiles/:id/auto-compact` as the setting reads it. */
export interface AutoCompactStatusView {
  agent: Agent;
  tokens: number | null;
  support:
    | { configurable: true; range: [number, number] }
    | { configurable: false; reason: string };
  reported: (ContextThreshold & { at: number }) | null;
  sessions: {
    title: string;
    state: "applied" | "waiting" | "restarting" | "unknown";
    restartNow: boolean;
    interrupts: string[];
  }[];
}
/**
 * The 自动压缩阈值 setting's text: what to type, the trigger
 * point the Agent reported, each online conversation's state, and what
 * 立即重启 interrupts.
 */
export function autoCompactView(st: AutoCompactStatusView, now = Date.now()) {
  const who = st.agent === "codex" ? "Codex" : "Claude";
  const range = st.support.configurable
    ? `${kTokens(st.support.range[0])}–${kTokens(st.support.range[1])}`
    : "";
  const explain =
    st.agent === "claude"
      ? t("ui-present.ac.explainClaude", { range })
      : st.agent === "codex"
        ? t("ui-present.ac.explainCodex", { range })
        : t("ui-present.ac.explainOther", { agent: agentShortName(st.agent) });
  const r = st.reported;
  const current =
    !!r &&
    (st.tokens === null
      ? r.origin !== "identity"
      : // Claude: the --autocompact window; Codex: the limit read back
        // (its trigger point may be capped below it).
        r.window === st.tokens);
  const point = (x: NonNullable<typeof r>) =>
    x.tokens === null
      ? t("ui-present.ac.pointNone", { reason: x.reason || t("ui-present.ac.notReported") })
      : t("ui-present.ac.point", {
          window:
            x.window && x.window !== x.tokens
              ? t(st.agent === "codex" ? "ui-present.ac.windowLimit" : "ui-present.ac.windowCompact", {
                  k: kTokens(x.window),
                })
              : "",
          approx: x.exact ? t("ui-present.ac.approxExact") : "≈",
          tokens: kTokens(x.tokens),
          by:
            st.agent === "codex" && x.origin === "cli-default"
              ? t("ui-present.ac.byCodexRule")
              : t("ui-present.ac.reportedBy", { who }),
          ago: agoText(now - x.at),
        });
  const trigger = !r
    ? t("ui-present.ac.triggerNone")
    : current
      ? t("ui-present.ac.trigger", { point: point(r) })
      : t("ui-present.ac.triggerProcess", { point: point(r), who });
  const lines: { text: string; tone: "ok" | "wait" | "muted" }[] = [];
  if (!st.sessions.length)
    lines.push({ text: t("ui-present.ac.noneOnline"), tone: "muted" });
  const list = (xs: string[]) => xs.join(t("ui-present.listSep"));
  for (const x of st.sessions)
    lines.push(
      x.state === "applied"
        ? { text: t("ui-present.ac.applied", { title: x.title }), tone: "ok" }
        : x.state === "restarting"
          ? { text: t("ui-present.ac.restarting", { title: x.title }), tone: "wait" }
          : x.state === "unknown"
            ? {
                text: t("ui-present.ac.unknown", {
                  title: x.title,
                  why: st.support.configurable
                    ? t("ui-present.ac.runnerOld")
                    : t("ui-present.ac.cannotApply"),
                }),
                tone: "muted",
              }
            : {
                text: t("ui-present.ac.waiting", {
                  title: x.title,
                  state: x.restartNow
                    ? t("ui-present.ac.restartRequested")
                    : x.interrupts.length
                      ? t("ui-present.ac.waitIdle", { what: list(x.interrupts) })
                      : t("ui-present.ac.idle"),
                }),
                tone: "wait",
              },
    );
  const busy = st.sessions.filter(
    (x) => x.state === "waiting" && x.interrupts.length && !x.restartNow,
  );
  return {
    configurable: st.support.configurable,
    ...(st.support.configurable ? {} : { disabledReason: st.support.reason }),
    explain,
    trigger,
    lines,
    restartable: busy.length > 0,
    confirmText: t("ui-present.ac.confirm", {
      list: busy
        .map((x) => t("ui-present.ac.confirmItem", { title: x.title, what: list(x.interrupts) }))
        .join(t("ui-present.sep")),
    }),
    settling: st.sessions.some(
      (x) => x.state === "waiting" || x.state === "restarting",
    ),
  };
}
const base = (p: unknown) => {
  const s = String(p ?? "");
  return s.split(/[\\/]/).filter(Boolean).pop() || s;
};
const host = (u: unknown) => {
  try {
    return new URL(String(u)).host;
  } catch {
    return short(String(u ?? ""), 40);
  }
};
/**
 * What one step of a turn does, in a few words (the trace bar):
 * 「读取 chat.tsx」「运行 npm test」「搜索 “contextFill”」.
 */
export function stepPhrase(i: Item): string {
  if (i.kind === "thinking") return t("ui-present.step.thinking");
  const x = (i.input || {}) as any;
  const cmd = commandOf(x);
  const run = () =>
    cmd ? t("ui-present.step.run", { cmd: short(cmd, 60) }) : t("ui-present.step.runCommand");
  switch (i.name) {
    case "Read":
      return t("ui-present.step.read", { file: base(x.file_path) });
    case "Write":
      return t("ui-present.step.write", { file: base(x.file_path) });
    case "Edit":
    case "MultiEdit":
      return t("ui-present.step.edit", { file: base(x.file_path) });
    case "NotebookEdit":
      return t("ui-present.step.edit", { file: base(x.notebook_path) });
    case "Bash":
    case "commandExecution":
      return run();
    case "BashOutput":
      return t("ui-present.step.bashOutput");
    case "Grep":
      return x.pattern
        ? t("ui-present.step.grep", { pattern: short(String(x.pattern), 30) })
        : t("ui-present.step.grepCode");
    case "Glob":
      return x.pattern
        ? t("ui-present.step.glob", { pattern: short(String(x.pattern), 30) })
        : t("ui-present.step.globFiles");
    case "WebFetch":
      return t("ui-present.step.webFetch", { host: host(x.url) });
    case "WebSearch":
      return x.query
        ? t("ui-present.step.webSearchQuery", { query: short(String(x.query), 30) })
        : t("ui-present.step.webSearch");
    case "Task":
    case "Agent":
      return t("ui-present.step.subagent", {
        what: short(String(x.description || x.prompt || ""), 40),
      });
    case "TodoWrite":
      return t("ui-present.step.todo");
    case "ScheduleWakeup":
      return x.delaySeconds
        ? t("ui-present.step.wakeupIn", { seconds: x.delaySeconds })
        : t("ui-present.step.wakeup");
    case "CronCreate":
      return t("ui-present.step.cronCreate");
    case "CronDelete":
      return t("ui-present.step.cronDelete");
    case "Monitor":
      return t("ui-present.step.monitor");
    case "Skill":
      return t("ui-present.step.skill", { skill: x.skill || x.name || "" }).trim();
    case "ToolSearch":
      return t("ui-present.step.toolSearch");
    case "AskUserQuestion":
      return t("ui-present.step.ask");
    case "fileChange":
      return t("ui-present.step.fileChange");
    case "webSearch":
      return t("ui-present.step.webSearch");
    case "mcpToolCall":
      return t("ui-present.step.mcp");
    case "contextCompaction":
      return t("ui-present.step.compact");
  }
  if (i.category === "subagent")
    return t("ui-present.step.subagentItem", { name: i.name || t("ui-present.step.working") });
  if (cmd) return run();
  return i.name || t("ui-present.step.tool");
}
/** 「42 秒」「3 分 05 秒」「1 小时 2 分」. */
export function elapsedText(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return t("ui-present.elapsed.s", { s });
  const m = Math.floor(s / 60);
  if (m < 60) return t("ui-present.elapsed.ms", { m, s: String(s % 60).padStart(2, "0") });
  return t("ui-present.elapsed.hm", { h: Math.floor(m / 60), m: m % 60 });
}
/** 「刚刚」「3 分钟前」「2 小时前」「3 天前」. */
export function agoText(ms: number) {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 1) return t("ui-present.ago.now");
  if (m < 60) return t("ui-present.ago.minutes", { n: m });
  const h = Math.floor(m / 60);
  return h < 24
    ? t("ui-present.ago.hours", { n: h })
    : t("ui-present.ago.days", { n: Math.floor(h / 24) });
}
/** Background work of an online Agent by Claude Code task_type. */
const TASK_TYPES: Record<string, { icon: string; kind: string }> = {
  local_bash: { icon: "▣", kind: "command" },
  monitor_mcp: { icon: "◉", kind: "monitor" },
  monitor_ws: { icon: "◉", kind: "monitor" },
  local_agent: { icon: "◇", kind: "subagent" },
  remote_agent: { icon: "◇", kind: "remoteAgent" },
  in_process_teammate: { icon: "◇", kind: "teammate" },
  local_workflow: { icon: "◇", kind: "workflow" },
  dream: { icon: "◌", kind: "dream" },
  // Daisy's own (kept by the control plane; ADR-152: an older
  // server's `harbor_bash` / `harbor_monitor` read through normalizeLiveTimer).
  scheduler_bash: { icon: "▣", kind: "command" },
  scheduler_monitor: { icon: "◉", kind: "monitor" },
  // a Codex unified-exec command left running (backgroundTerminals).
  codex_terminal: { icon: "▣", kind: "command" },
};
/**
 * whose item it is, for the 「后台」 list — Daisy's scheduler, or
 * the Agent itself (by the session's agent).
 */
export function backgroundSource(
  item: { source?: string },
  agent?: string,
): string {
  if (isSchedulerItem(item)) return PRODUCT_NAME;
  return agent ? agentShortName(agent) : "";
}
/**
 * the item's own 「停止」 / 「取消」 (null: it cannot be stopped
 * alone — 「下线」 ends the Agent's own). Daisy's are cancelled by Daisy;
 * the Agent's only where the control plane marked them `stoppable`.
 */
export function backgroundStop(
  item: Pick<LiveTimer, "kind" | "stoppable" | "stopping"> & { source?: string },
): { label: string; busy: boolean } | null {
  if (!isSchedulerItem(item) && !item.stoppable) return null;
  if (item.stopping) return { label: t("ui-present.bg.stopping"), busy: true };
  return {
    label: item.kind === "task" ? t("ui-present.bg.stop") : t("ui-present.bg.cancel"),
    busy: false,
  };
}
/**
 * C1-c: what 「下线」 does to the 「后台」 list, said exactly: the Agent's own items end with its process; Daisy's do not —
 * its timers are kept (and survive a restart), its background commands run
 * on until they end or are stopped one by one (a restart of Daisy stops
 * them, reported as interrupted). Either wakes the AI when it ends.
 */
export function offlineEffect(native: number, scheduler: LiveTimer[]): string {
  const tasks = scheduler.filter((p) => p.kind === "task").length;
  const parts = [
    native ? t("ui-present.offline.nativeEnds") : "",
    tasks ? t("ui-present.offline.tasksStay", { n: tasks }) : "",
  ].filter(Boolean);
  return parts.length
    ? t("ui-present.offline.effect", { parts: parts.join(t("ui-present.sep")) })
    : "";
}
export function daisyOfflineNote(scheduler: LiveTimer[]): string {
  const tasks = scheduler.some((p) => p.kind === "task"),
    timers = scheduler.some((p) => p.kind !== "task");
  return t("ui-present.offline.note", {
    timers: timers ? t("ui-present.offline.noteTimers") : "",
    tasks: tasks ? t("ui-present.offline.noteTasks") : "",
  });
}
/**
 * 「后台 N 项」: the online process's own timers / background work
 * (gone when it goes offline) and Daisy's (kept while offline).
 */
/** ADR-152: a session from any server version (`harborPending` before). */
type BackgroundHolder = Pick<Session, "live" | "schedulerPending"> & {
  harborPending?: LiveTimer[];
};
export function backgroundOf(s: BackgroundHolder | undefined): LiveTimer[] {
  return [
    ...(s?.live?.online ? s.live.pending || [] : []),
    ...schedulerPendingOf(s),
  ];
}
export const backgroundCount = (s: BackgroundHolder | undefined) =>
  backgroundOf(s).length;
/** 「后台命令」「子 Agent」「定时器」… and a plain symbol for one pending item. */
export function backgroundKind(item: Pick<LiveTimer, "kind" | "type">) {
  if (item.kind === "wakeup") return { icon: "◷", kind: t("ui-present.bgKind.wakeup") };
  if (item.kind === "cron") return { icon: "↻", kind: t("ui-present.bgKind.cron") };
  const type = normalizeLiveTimer({ id: "", label: "", ...item }).type;
  const k = TASK_TYPES[type || ""] ?? { icon: "◌", kind: "task" };
  return { icon: k.icon, kind: t.dynamic(`ui-present.bgKind.${k.kind}`) };
}
/** Background command / Monitor output: they can be read (get_task_output). */
export const hasOutput = (t: Pick<LiveTimer, "type">) =>
  ["local_bash", "monitor_mcp", "monitor_ws"].includes(t.type || "");
const NOT_STEPS = ["usage", "audit", "lifecycle"];
/**
 * Whether a trace item is a step the Agent took — not the
 * Runner's own stages (lifecycle), usage / audit records, the context
 * gauge, or Claude Code's hook events; 「完成 N 个步骤」 counts only these
 * (before, a turn of interrupts and notifications read 「完成 6 个步骤」).
 */
export function isStep(i: Pick<Item, "id" | "category" | "name" | "kind">) {
  if (NOT_STEPS.includes(i.category || "")) return false;
  if (i.id.endsWith(":context")) return false;
  if (i.kind === "notice") return false;
  if (i.category === "native" && /hook/i.test(i.name || "")) return false;
  return true;
}
/**
 * The trace bar's line for a running turn: which step, what it
 * does, how long — 「第 7 步 · 正在运行 npm test · 42 秒」. `items` are the
 * turn's activity (tool / thinking), oldest first.
 */
export function stepLine(
  items: readonly Item[],
  now: number,
  options: { streaming?: boolean } = {},
): string {
  const steps = items.filter(
    (i) => !NOT_STEPS.includes(i.category || "") && !i.id.endsWith(":context"),
  );
  const running = [...steps]
    .reverse()
    .find((i) => ["running", "streaming", "pending"].includes(i.status || ""));
  if (running) {
    const n = steps.indexOf(running) + 1;
    return t("ui-present.stepLine.running", {
      n,
      step: stepPhrase(running),
      elapsed: elapsedText(now - running.createdAt),
    });
  }
  const last = steps.at(-1);
  if (options.streaming)
    return last
      ? t("ui-present.stepLine.doneWriting", { n: steps.length })
      : t("ui-present.stepLine.writing");
  if (last)
    return t("ui-present.stepLine.done", { n: steps.length, step: stepPhrase(last) });
  // Before the first real step: the runner's own stages.
  const stage = [...items].reverse().find((i) => i.category === "lifecycle");
  return stage?.name ? `${stage.name}…` : t("ui-present.stepLine.preparing");
}
/**
 * Which of `groupTurns`' turns is the current one — what the trace bar above
 * the composer describes: the last turn, skipping trailing turns
 * that have not started. `waiting(id, head)` says whether a turn's head is
 * a job still queued behind the running one (「等待发送」) — the owner's
 * message, a request from someone else (`user:<jid>` with an origin) or a Daisy wake
 * (`wake:<jid>`, a cron / timer that fired while a turn runs). A user message removed from the queue
 * (`cancelled`) never started either. A user head that was accepted
 * (started) always counts as begun.
 */
export function currentTurnIndex<
  T extends { id: string; kind: string; status?: string },
>(
  turns: readonly (readonly T[])[],
  waiting: (id: string, head: T) => boolean,
): number {
  let i = turns.length - 1;
  while (i > 0) {
    const turn = turns[i],
      head = turn[0];
    // Anything of its own but notices (a step, a reply): it has begun.
    if (
      !head ||
      !notStarted(head, waiting) ||
      turn.some((x, n) => n > 0 && x.kind !== "notice")
    )
      break;
    i--;
  }
  return i;
}
function notStarted<T extends { id: string; kind: string; status?: string }>(
  head: T,
  waiting: (id: string, head: T) => boolean,
) {
  if (head.kind === "user") {
    if (head.status === "cancelled" && head.id.startsWith("user:")) return true;
    return head.status === "queued" && waiting(head.id, head);
  }
  // A wake removed from the queue (`cancelled`) never started either.
  return (
    head.id.startsWith("wake:") &&
    (head.status === "cancelled" || waiting(head.id, head))
  );
}
const JOB_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * The conversation's turns, in order. A turn starts at a user message or at
 * the marker of a turn the Agent started itself; a job's items
 * (`<jobId>:…`) stay with the turn of that job even when they arrive after a
 * later message (a queued message, a background task finishing between
 * turns), and a job without a message of its own (an operation such as
 * /compact) is a turn of its own.
 */
export function groupTurns<
  T extends { id: string; kind: string; category?: string; status?: string },
>(
  items: readonly T[],
  /**
   * item ids of jobs still queued (`user:<jid>`, `wake:<jid>`).
   * Their head does not become the turn a message added to the running
   * turn (立即追加) joins — that stays with the running job.
   */
  waiting?: (id: string) => boolean,
): T[][] {
  const turns: T[][] = [],
    byJob = new Map<string, T[]>();
  let lastJob: string | null = null;
  for (const item of items) {
    const colon = item.id.indexOf(":"),
      head = colon > 0 ? item.id.slice(0, colon) : "",
      rest = colon > 0 ? item.id.slice(colon + 1).split(":")[0] : "";
    // a queued job delivered into the running turn natively
    // (`appendedInto`) belongs to that turn, like a 立即追加.
    const appended = !!(item as { appendedInto?: string }).appendedInto;
    if (
      (head === "user" || head === "wake") &&
      JOB_ID.test(rest) &&
      !appended
    ) {
      const turn = [item];
      turns.push(turn);
      byJob.set(rest, turn);
      // A queued one, or one removed from the queue, has not started.
      if (!waiting?.(item.id) && item.status !== "cancelled") lastJob = rest;
      continue;
    }
    if (item.kind === "user") {
      // A message added to the running turn: what follows belongs after it.
      const turn = [item];
      // N-2b (C-1 device acceptance, 2026-11-17): a queued job delivered
      // into a running turn (`appendedInto`) belongs to THAT job and is
      // shown right after it — not to whichever job's message came last in
      // the list (a message queued before it, 乙, that ran only after it:
      // its reply landed under 丙's bubble and the order read 甲→乙→丙
      // although Claude answered 丙 before 乙).
      const into = appended
        ? (item as { appendedInto?: string }).appendedInto!
        : null;
      const host = into ? byJob.get(into) : undefined;
      const at = host ? turns.lastIndexOf(host) : -1;
      if (at >= 0) turns.splice(at + 1, 0, turn);
      else turns.push(turn);
      const owner = host ? into : lastJob;
      if (owner) byJob.set(owner, turn);
      continue;
    }
    const job = JOB_ID.test(head) ? head : null;
    if (job) {
      let turn = byJob.get(job);
      if (!turn) {
        turn = [];
        turns.push(turn);
        byJob.set(job, turn);
      }
      turn.push(item);
      lastJob = job;
      continue;
    }
    if (!turns.length) turns.push([]);
    turns[turns.length - 1].push(item);
  }
  return turns.filter((t) => t.length);
}

/**
 * N-3 (C-1 device acceptance): how one turn of the conversation ended, for
 * its trace line (「○ … · 已中断」). Its own end line says (a turn that was
 * stopped or failed has one: `<jobId>:turn-end`, or an older random-id
 * notice filed under it); the current turn also goes by the session's
 * status. Before, every finished turn took the session's status, so one
 * stop marked the whole history 「已中断」 until the next turn.
 */
export function turnEnd(
  turn: readonly { kind: string; status?: string }[],
  current?: string,
): string | undefined {
  const end = turn.find(
    (x) =>
      x.kind === "notice" &&
      (x.status === "interrupted" || x.status === "error"),
  );
  return end?.status ?? current;
}

/**
 * The heading of a user-role item that is not the owner's words (`origin`):
 * a peer's question, a peer's reply, an unfinished request — or
 * a Daisy event such as the automatic
 * classifier retry, which is neither a collaboration nor a failure. Rows
 * from before `event` are recognised by their sender (Harbor 系统 · 自动模式).
 */
export function originHeading(
  o: {
    type: string;
    senderKind?: string;
    senderName?: string;
    place?: string;
    event?: string;
  },
  who: string,
): { heading: string; failure: boolean; event: boolean } {
  if (
    o.event === "classifier-retry" ||
    (o.type === "peer-failure" &&
      isSystemSender(o.senderName) &&
      // An older row, by its stored place (written in Chinese then).
      /^自动模式$/.test(o.place || ""))
  )
    return {
      heading: t("ui-present.origin.classifierRetry"),
      failure: false,
      event: true,
    };
  if (o.type === "peer")
    return {
      heading:
        o.senderKind === "agent"
          ? t("ui-present.origin.questionFromAgent", { who })
          : t("ui-present.origin.questionFrom", { who }),
      failure: false,
      event: false,
    };
  if (o.type === "peer-reply")
    return { heading: t("ui-present.origin.reply", { who }), failure: false, event: false };
  return { heading: t("ui-present.origin.unfinished"), failure: true, event: false };
}
/**
 * The small delivery text next to 「你」 on a user message. Daisy accepted
 * it; only a queued-behind message waits (no 「等待发送」
 * flash right after sending). Follow-up 2026-11-09 (a user misread a
 * stall): an accepted message added to a running turn says whether the
 * agent read it yet (`delivery`; older servers send none → 「已接收」).
 */
export function userStatusText(
  item: Pick<Item, "status" | "delivery">,
  copy: {
    userStatusQueued: string;
    userStatusSent: string;
    userStatusAccepted: string;
    userStatusHanded: string;
    userStatusRead: string;
    userStatusError: string;
    userStatusCancelled: string;
    userStatusRequeued: string;
    userStatusAppended: string;
  },
  waiting = false,
): string {
  const status = item.status || "";
  const text: Record<string, string> = {
    queued: waiting ? copy.userStatusQueued : copy.userStatusSent,
    accepted:
      item.delivery === "read"
        ? copy.userStatusRead
        : item.delivery === "handed"
          ? copy.userStatusHanded
          : copy.userStatusAccepted,
    error: copy.userStatusError,
    cancelled: copy.userStatusCancelled,
    requeued: copy.userStatusRequeued,
    // in the running turn's native queue, not read yet.
    appended: copy.userStatusAppended,
    // went in with a jumped message (合并插队).
    merged: t("ui-present.userStatus.merged"),
  };
  return text[status] || status;
}

/** Reasoning effort in words (the known values; others: undefined). */
export const effortName = (e: string): string | undefined =>
  e && t.has(`ui-present.effort.${e}`) ? t.dynamic(`ui-present.effort.${e}`) : undefined;
export const effortText = (e: string) => {
  const name = effortName(e);
  return name ? t("ui-present.effortText", { name, value: e }) : e;
};
/**
 * N-8: the /status panel's state, as a key of `copy.labels`. `idle` is
 * the session's raw status between turns, so it alone reads 「未开始」 for a
 * conversation that has run many turns: an idle session that has had a
 * turn (its context delivered, a native session, or turns in the
 * transcript) is `completed`, as the session list's chip says
 * (host.tsx daisySessionPhase); only one that never ran is `idle`.
 */
export function sessionStateKey(
  session: Pick<Session, "status" | "nativeId" | "contextDelivered">,
  items: readonly Pick<Item, "kind">[] = [],
): string {
  if (session.status !== "idle") return session.status;
  const ran =
    !!session.contextDelivered ||
    !!session.nativeId ||
    items.some((i) => i.kind === "user" || i.kind === "assistant");
  return ran ? "completed" : "idle";
}
/** One line of the /status panel. */
export interface StatusRow {
  label: string;
  value: string;
  note?: string;
}
/**
 * N-5 (C-1 device acceptance): the /status panel — where the conversation
 * runs, the model and reasoning effort the Agent itself reported it runs
 * with (`session.runtime`; a choice still waiting for
 * the next turn is said so), and the usage the harness reports (the
 * context ring's rows: plan quota, cache, context). Nothing is
 * made up: what was not reported says 「不可用」 and why.
 */
export function statusRows(
  session: Pick<
    Session,
    | "agent"
    | "status"
    | "nativeId"
    | "contextDelivered"
    | "runtime"
    | "settings"
    | "context"
    | "quota"
  > & { quotaHidden?: boolean },
  where: { account?: string; node?: string; directory?: string } = {},
  items: readonly Item[] = [],
  now = Date.now(),
): StatusRow[] {
  const na = (note: string): Pick<StatusRow, "value" | "note"> => ({
    value: t("ui-present.na"),
    note,
  });
  const got = session.runtime,
    want = session.settings || {};
  const pending = (chosen: string | undefined, running: string | undefined) =>
    chosen && chosen !== running
      ? t("ui-present.status.pending", { value: chosen })
      : undefined;
  const rows: StatusRow[] = [
    { label: t("ui-present.status.agent"), value: session.agent },
    { label: t("ui-present.status.state"), value: sessionStateKey(session, items) },
    where.account ? { label: t("ui-present.status.profile"), value: where.account } : null,
    where.node ? { label: t("ui-present.status.node"), value: where.node } : null,
    where.directory ? { label: t("ui-present.status.directory"), value: where.directory } : null,
    {
      label: t("ui-present.status.native"),
      ...(session.nativeId
        ? { value: session.nativeId }
        : na(t("ui-present.status.noTurn"))),
    },
  ].filter(Boolean) as StatusRow[];
  const model = pending(want.model, got?.model);
  rows.push({
    label: t("ui-present.status.model"),
    ...(got?.model
      ? { value: got.model, ...(model ? { note: model } : {}) }
      : na(model || t("ui-present.status.notYet"))),
  });
  const effort = pending(want.reasoningEffort, got?.effort);
  rows.push({
    label: t("ui-present.status.effort"),
    ...(got?.effort
      ? {
          value: effortText(got.effort),
          ...(effort ? { note: effort } : {}),
        }
      : na(
          effort ||
            (got?.model
              ? t("ui-present.status.effortNotReported")
              : t("ui-present.status.notYet")),
        )),
  });
  if (got?.permissionMode)
    rows.push({ label: t("ui-present.status.permissionMode"), value: got.permissionMode });
  for (const r of contextBubble(session, items, now))
    rows.push({
      label: r.label,
      value: r.value,
      ...(r.note ? { note: r.note } : {}),
    });
  return rows;
}
