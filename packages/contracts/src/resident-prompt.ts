import { z } from "zod";
import { PRODUCT_NAME } from "./names.ts";
import {
  localTimeZone,
  zoneName,
  type ResidentConfig,
  type ResidentTask,
} from "./scheduler.ts";
import {
  sessionToolNames,
  toolId,
  type ToolNames,
} from "./native-tools.ts";
import type { Session } from "./session.ts";
import type { MessageKey } from "./i18n-keys.gen.ts";
import {
  LEGACY_PROMPT_LANG,
  promptForms,
  promptT,
  sessionLang,
  type PromptT,
} from "./prompt-i18n.ts";
/** Where no session says which: a session created before P6-24 (Chinese). */
const legacyT = () => promptT(LEGACY_PROMPT_LANG);
/**
 * the built-in prompt of a 「任务常驻 Agent」, in sections its
 * owner can see — and, for some, change. One function builds them for the
 * control plane (the settings page's preview, and the text it sends with
 * every job as `residentGuide`) and for a Runner whose control plane is
 * older (no `residentGuide`: built from the session alone).
 *
 * - default sections: Daisy's wording; the owner may replace the text
 *   (`overrides`) or put it back (reset).
 * - derived sections: written from the resident's own settings (purpose,
 *   bound tasks, scope, budget) — changed there, not as text, so the
 *   prompt never says something the server does not enforce.
 * - custom sections: the owner's own, after Daisy's.
 * - the safety section: read-only, last, and above everything else.
 */
export type ResidentPromptSectionId =
  | "role"
  | "purpose"
  | "tasks"
  | "scope"
  | "say"
  | "time"
  | "workstyle"
  | "context"
  | "budget"
  | "wake"
  | "safety";
/** The sections whose text its owner may replace. */
export const RESIDENT_PROMPT_EDITABLE = [
  "role",
  "say",
  "time",
  "workstyle",
  "context",
  "wake",
] as const;
export type ResidentPromptEditable = (typeof RESIDENT_PROMPT_EDITABLE)[number];
/**
 * with the layered prompt (`guide`), also the two static sections
 * moved up from each turn — and (below) the unlocked sections of the org
 * core. `RESIDENT_PROMPT_EDITABLE` stays the six of the older text.
 */
export const RESIDENT_SESSION_EDITABLE = [
  ...RESIDENT_PROMPT_EDITABLE,
  "collab",
  "workspace",
] as const;
/** An org section its owner may change: named by its title's hash, never a fixed name. */
export const orgEditableKey = (k: string) => /^org:[0-9a-f]{8}(:\d+)?$/.test(k);
/** May a resident's owner replace or switch off section `k`? */
export function residentEditableKey(k: string): boolean {
  return (
    (RESIDENT_SESSION_EDITABLE as readonly string[]).includes(k) ||
    orgEditableKey(k)
  );
}
/** Why `k` can be neither replaced nor switched off (the 400's words); "" = it can. */
export function residentLockedWhy(k: string, t: PromptT = legacyT()): string {
  if (residentEditableKey(k)) return "";
  if (k === "safety") return t("prompt-resident.locked.safety");
  if (k === "org:intro" || k === "org:tail" || /^org:redlines/.test(k))
    return t("prompt-resident.locked.org", { key: k });
  if (["purpose", "tasks", "scope", "budget"].includes(k))
    return t("prompt-resident.locked.derived", { key: k });
  return t("prompt-resident.locked.other", { key: k });
}
/**
 * The first words of each layer's marker line (keys: the session's
 * language writes them): text an owner writes may not hold a line that
 * starts like one — in any language (`allPromptMarkers`).
 */
export const PROMPT_MARKER_KEYS = [
  "prompt-guide.marker.org",
  "prompt-guide.marker.session",
  "prompt-guide.marker.owner",
  "prompt-guide.marker.safety",
] as const satisfies readonly MessageKey[];
/** Every language's marker lines. */
export const allPromptMarkers = (): string[] => PROMPT_MARKER_KEYS.flatMap((k) => promptForms(k));
/**
 * `text` as a reader of markers sees it: characters that show nothing
 * (zero-width, soft hyphen, direction marks, tags) dropped, every kind of
 * line break one "\n" — so a marker cannot be hidden behind a lone "\r" or
 * split by an invisible character.
 */
export function plainPromptText(text: string): string {
  return String(text ?? "")
    .replace(
      /[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]|\udb40[\udc00-\udc7f]/g,
      "",
    )
    .replace(/\r\n?|[\u0085\u000b\u000c\u2028\u2029]/g, "\n");
}
/** The marker a line of `text` imitates, or null. */
export function forgedMarker(text: string): string | null {
  const markers = allPromptMarkers();
  for (const line of plainPromptText(text).split("\n")) {
    const t = line.trimStart();
    const m = markers.find((x) => t.startsWith(x));
    if (m) return m;
  }
  return null;
}
export const RESIDENT_PROMPT_LIMITS = {
  sectionMax: 4000,
  customSections: 10,
  titleMax: 60,
} as const;
/** What its owner changed (stored on `resident.prompt`). */
export interface ResidentPromptConfig {
  /**
   * Replaced text of editable sections: the six a resident always had, and with the
   * layered prompt `collab`, `workspace` and `org:<hash>`.
   */
  overrides: Partial<Record<string, string>>;
  /** sections switched off (same keys as `overrides`). */
  disabled?: string[];
  /** per replaced org section, the SHA-256 of the L1 text it replaced. */
  orgBase?: Record<string, string>;
  /** Its owner's own sections, in order, after Daisy's. */
  custom: { id: string; title: string; text: string }[];
  updatedAt: number;
  updatedBy: string;
}
export interface ResidentPromptSection {
  id: string;
  title: string;
  /** Where the text comes from, in words. */
  source: string;
  /** default: Daisy's (editable) · derived: from its settings · custom: its owner's · locked: read-only. */
  kind: "default" | "derived" | "custom" | "locked";
  text: string;
  /** default sections: Daisy's own text (what reset puts back). */
  defaultText?: string;
  /** default sections: its owner replaced the text. */
  overridden?: boolean;
  /** Why it cannot be edited here (derived / locked). */
  reason?: string;
  /**
   * Additive (`kind` keeps its four values for older Apps): the
   * layer it is in, its state in that layer, switched off by its owner,
   * an org section L1 changed since it was replaced, a stored replacement
   * whose org section is gone.
   */
  layer?: "org" | "session" | "owner" | "safety";
  state?: "default" | "overridden" | "disabled" | "locked" | "derived" | "custom";
  disabled?: boolean;
  orgChanged?: boolean;
  orphan?: boolean;
  /** Left out of the text for length. */
  trimmed?: boolean;
}
/** PUT /api/sessions/:id/resident/prompt — the whole set. */
export const ResidentPromptUpdateSchema = z
  .object({
    overrides: z
      .record(
        z.string(),
        z.string().trim().max(RESIDENT_PROMPT_LIMITS.sectionMax),
      )
      .default({}),
    custom: z
      .array(
        z.object({
          id: z.string().trim().max(40).default(""),
          title: z.string().trim().min(1).max(RESIDENT_PROMPT_LIMITS.titleMax),
          text: z.string().trim().min(1).max(RESIDENT_PROMPT_LIMITS.sectionMax),
        }),
      )
      .max(RESIDENT_PROMPT_LIMITS.customSections)
      .default([]),
    /** sections switched off. Absent (an older client): unchanged. */
    disabled: z.array(z.string().trim().min(1).max(40)).max(60).optional(),
  })
  .superRefine((b, ctx) => {
    // Ids name a section for reset / history: two with one id would go together.
    const seen = new Set<string>();
    b.custom.forEach((c, i) => {
      if (!c.id) return;
      if (seen.has(c.id))
        ctx.addIssue({
          code: "custom",
          path: ["custom", i, "id"],
          message: legacyT()("prompt-resident.custom.duplicate", { id: c.id }),
        });
      seen.add(c.id);
    });
    for (const k of Object.keys(b.overrides)) {
      const why = residentLockedWhy(k);
      if (why)
        ctx.addIssue({
          code: "custom",
          path: ["overrides", k],
          // The older words where it already refused.
          message: residentOverrideRefusal(k) || why,
        });
    }
    (b.disabled || []).forEach((k, i) => {
      const why = residentLockedWhy(k);
      if (why)
        ctx.addIssue({ code: "custom", path: ["disabled", i], message: why });
    });
    // Layer markers in the text are looked for by the control plane, and
    // only where the layered prompt is on (`residentPromptForged`).
  });
/**
 * The older refusal of replacing section `k`, in its words ("" = that
 * older text let it be replaced). A control plane without the layered
 * prompt on for a session answers with exactly these.
 */
export function residentOverrideRefusal(k: string, t: PromptT = legacyT()): string {
  if ((RESIDENT_PROMPT_EDITABLE as readonly string[]).includes(k)) return "";
  if (k === "safety") return t("prompt-resident.refusal.safety");
  if (k === "org:intro" || k === "org:tail" || /^org:redlines/.test(k))
    return residentLockedWhy(k, t);
  return t("prompt-resident.locked.other", { key: k });
}
/**
 * text an owner writes may not hold a line that starts like a
 * layer's marker. The first such case in a parsed update, as the 400's
 * `[path, words]`, or null. (Checked where the layered prompt is on;
 * stored text that does is made harmless when composed.)
 */
export function residentPromptForged(
  b: {
    overrides: Record<string, string>;
    custom: { title: string; text: string }[];
  },
  t: PromptT = legacyT(),
): { path: (string | number)[]; message: string } | null {
  for (const [k, v] of Object.entries(b.overrides)) {
    const m = forgedMarker(v);
    if (m)
      return {
        path: ["overrides", k],
        message: t("prompt-resident.forged.section", { key: k, marker: m }),
      };
  }
  for (const [i, c] of b.custom.entries()) {
    const m = forgedMarker(c.text) || forgedMarker(c.title);
    if (m)
      return {
        path: ["custom", i, "text"],
        message: t("prompt-resident.forged.custom", { title: c.title, marker: m }),
      };
  }
  return null;
}
export type ResidentPromptUpdate = z.input<typeof ResidentPromptUpdateSchema>;
/** POST …/resident/prompt/reset — all of it, or one section. */
export const ResidentPromptResetSchema = z.object({
  section: z.string().trim().max(40).optional(),
});
/** What the settings page shows: sections, then what every turn adds. */
export interface ResidentPromptView {
  sections: ResidentPromptSection[];
  /** The text the Agent gets as system prompt / developer instructions. */
  text: string;
  /** Added to each turn's message by the Runner (read-only here). */
  perTurn: ResidentPromptSection[];
  /** Latest changes (newest first). */
  history: {
    at: number;
    by: string;
    action: "update" | "reset" | "disable" | "enable";
    section?: string;
    summary: string;
  }[];
  /**
   * Absent from an older control plane: is the layered prompt on
   * for this session, which org core it gets, how long the text is, and
   * when a change reaches the Agent.
   */
  layered?: {
    /** false: the older text (`residentGuide`) is what the Runner gets. */
    on: boolean;
    /** Why not, in words. */
    why?: string;
    org: {
      docId: string;
      version: number;
      sha256: string;
      fetchedAt: number;
      level: 1 | 2 | 3 | 4;
      /** The control plane's copy, last checked more than a day ago. */
      expired?: boolean;
    } | null;
    /** No 「红线」 section in this core: the whole org layer is locked. */
    orgLocked?: boolean;
    chars: number;
    max: number;
    /** "next-start": the next process start · "after-compact": only after a compaction. */
    effect: "next-start" | "after-compact";
    effectText: string;
    /** Is the text above what its conversation holds now, and in words. */
    effective?: "yes" | "stale" | "unknown";
    effectiveText?: string;
    /** 「立即压缩并生效」 (`POST /sessions/:id/prompt/apply`): can it be asked for, where it stands. */
    apply?: {
      available: boolean;
      state?: "waiting" | "running" | "done" | "failed" | "skipped" | "cancelled";
      note?: string;
    };
    /** "runner": the core is what its Runner reported, unchecked by the control plane. */
    orgSource?: "control-plane" | "runner";
  };
}
/** Read-only safety rules: why (shown next to them). */
export const safetyReason = (t: PromptT) => t("prompt-resident.safety.reason");
const DERIVED_REASON: Record<string, MessageKey> = {
  purpose: "prompt-resident.derived.purpose",
  tasks: "prompt-resident.derived.tasks",
  scope: "prompt-resident.derived.scope",
  budget: "prompt-resident.derived.budget",
};
type ResidentSessionLike = {
  agent: string;
  /** P6-24: the session's language (absent: created before, Chinese). */
  lang?: string;
  task?: { id: string; title?: string } | null;
  resident?: ResidentConfig | null;
} & Partial<Pick<Session, "nativeId" | "nativeTools">>;
const tool = (agent: string, n: string, names: ToolNames = "daisy") =>
  toolId(agent, n, names);
const taskName = (x: { id: string; title?: string }, t: PromptT) =>
  x.title && x.title !== x.id ? t("prompt-resident.taskName", { id: x.id, title: x.title }) : x.id;
function boundTasks(s: ResidentSessionLike): ResidentTask[] {
  if (Array.isArray(s.resident?.tasks)) return s.resident!.tasks!;
  return s.task?.id
    ? [{ id: s.task.id, title: s.task.title || s.task.id }]
    : [];
}
/** 「可更新的任务」 in the settings page's words. */
export function taskScopeText(
  tasks: "bound" | "all" | string[],
  bound: { id: string; title?: string }[],
  t: PromptT = legacyT(),
): string {
  const sep = t("prompt-native.listSep");
  const names = (list: { id: string; title?: string }[]) => list.map((x) => taskName(x, t)).join(sep);
  if (tasks === "bound")
    return bound.length
      ? t("prompt-resident.scope.boundSome", { list: names(bound) })
      : t("prompt-resident.scope.boundNone");
  if (tasks === "all")
    return t("prompt-resident.scope.all", {
      bound: bound.length ? t("prompt-resident.scope.allBound", { list: names(bound) }) : "",
    });
  if (!tasks.length) return t("prompt-resident.scope.none");
  return t("prompt-resident.scope.only", {
    list: tasks
      .map((id) => {
        const b = bound.find((x) => x.id === id);
        return b ? taskName(b, t) : id;
      })
      .join(sep),
  });
}
/** Daisy's default text of each editable section. */
export function defaultSectionText(
  id: ResidentPromptEditable,
  agent: string,
  /** ADR-154: the names the conversation knows Daisy's tools by. */
  toolNames: ToolNames = "daisy",
  /** The zone its cron expressions are read in (default: this machine's). */
  zone: string = zoneName(localTimeZone()),
  /** P6-24: the session's language. */
  t: PromptT = legacyT(),
  /** An ordinary session has no `say`: the workstyle reports without it. */
  o: { say?: boolean } = {},
): string {
  const n = (x: string) => tool(agent, x, toolNames);
  switch (id) {
    case "role":
      return t.long("resident-role");
    case "say":
      return t.long("resident-say", { say: n("say") });
    case "time":
      return t.long("resident-time", {
        wakeup: n("wakeup"),
        cron: n("cron"),
        zone,
        bash: n("bash"),
        monitor: n("monitor"),
        schedules: n("schedules"),
        cancel: n("cancel"),
      });
    case "workstyle":
      return t.long("resident-workstyle", {
        sub: agent === "claude" ? t("prompt-resident.subagents.claude") : "spawn_agent",
        bash: n("bash"),
        monitor: n("monitor"),
        cron: n("cron"),
        wakeup: n("wakeup"),
        report: t(o.say === false ? "prompt-resident.workstyle.report" : "prompt-resident.workstyle.reportSay"),
      });
    case "context":
      return t.long("resident-context");
    case "wake":
      return t.long("resident-wake");
  }
}
/** The read-only safety rules (always last). */
export const safetyText = (t: PromptT) => t.long("guide-safety");
/**
 * The sections, in order, with its owner's changes applied. Only its
 * owner's settings go in (nothing others can rename): the control plane
 * and a Runner on its own build the same text.
 */
export function residentPromptSections(
  s: ResidentSessionLike,
  opts: {
    /** ADR-154: default — by the session's own record (`sessionToolNames`). */
    toolNames?: ToolNames;
  } = {},
): ResidentPromptSection[] {
  const r = s.resident;
  if (!r) return [];
  const names =
    opts.toolNames ??
    sessionToolNames({
      agent: s.agent as Session["agent"],
      nativeId: s.nativeId ?? null,
      nativeTools: s.nativeTools,
    });
  const zone = r.timeZone || zoneName(localTimeZone());
  const t = promptT(sessionLang(s));
  const p = r.prompt;
  const bound = boundTasks(s);
  const editable = (
    id: ResidentPromptEditable,
    title: string,
  ): ResidentPromptSection => {
    const def = defaultSectionText(id, s.agent, names, zone, t);
    const own = p?.overrides?.[id];
    return {
      id,
      title,
      source: t(own ? "prompt-guide.source.ownerChanged" : "prompt-resident.source.default"),
      kind: "default",
      text: own || def,
      defaultText: def,
      overridden: !!own,
      // switched off by its owner — listed, not in the text.
      ...(p?.disabled?.includes(id) ? { disabled: true } : {}),
    };
  };
  const derived = (
    id: string,
    title: string,
    text: string,
  ): ResidentPromptSection => ({
    id,
    title,
    source: t("prompt-resident.source.derived"),
    kind: "derived",
    text,
    reason: DERIVED_REASON[id] && t.dynamic(DERIVED_REASON[id]),
  });
  const limits = [
    r.maxTurnMinutes ? t("prompt-resident.limit.turnMinutes", { n: r.maxTurnMinutes }) : "",
    r.dailyTurns ? t("prompt-resident.limit.dailyTurns", { n: r.dailyTurns }) : "",
  ].filter(Boolean);
  return [
    editable("role", t("prompt-resident.title.role")),
    derived("purpose", t("prompt-resident.title.purpose"), t("prompt-resident.purpose", { purpose: r.purpose })),
    derived(
      "tasks",
      t("prompt-resident.title.tasks"),
      bound.length
        ? t("prompt-resident.tasks.some", {
            n: bound.length,
            list: bound.map((x) => `- ${taskName(x, t)}`).join("\n"),
          })
        : t("prompt-resident.tasks.none"),
    ),
    derived(
      "scope",
      t("prompt-resident.title.scope"),
      t("prompt-resident.scope.text", {
        scope: taskScopeText(r.scope.tasks, bound, t),
        say: tool(s.agent, "say", names),
      }),
    ),
    editable("say", t("prompt-resident.title.say")),
    editable("time", t("prompt-resident.title.time")),
    editable("workstyle", t("prompt-resident.title.workstyle")),
    editable("context", t("prompt-resident.title.context")),
    derived(
      "budget",
      t("prompt-resident.title.budget"),
      limits.length
        ? t("prompt-resident.budget.some", { limits: limits.join(t("prompt-resident.limit.sep")) })
        : t("prompt-resident.budget.none"),
    ),
    editable("wake", t("prompt-resident.title.wake")),
    ...(p?.custom || []).map((c): ResidentPromptSection => ({
      id: `custom:${c.id}`,
      title: c.title,
      source: t("prompt-guide.source.custom"),
      kind: "custom",
      text: c.text,
    })),
    {
      id: "safety",
      title: t("prompt-guide.safety.title"),
      source: t("prompt-guide.source.builtinReadOnly"),
      kind: "locked",
      text: safetyText(t),
      reason: safetyReason(t),
    },
  ];
}
/** The system prompt / developer instructions text (sections switched off left out). */
export function residentPromptText(sections: ResidentPromptSection[]) {
  return sections
    .filter((x) => !x.disabled && !x.orphan && !x.trimmed)
    .map((x) => x.text)
    .join("\n\n");
}
