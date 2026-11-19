import type { Session } from "./index.ts";
import { PRODUCT_NAME } from "./names.ts";
import { LEGACY_PROMPT_LANG as LEGACY_LANG } from "./prompt-i18n.ts";
import {
  daisyToolNames,
  missingThreadTools,
  missingToolsText,
  sessionToolNames,
  toolId,
  type ToolNames,
} from "./native-tools.ts";
import type { MessageKey } from "./i18n-keys.gen.ts";
import { sessionLang, promptT, type PromptT } from "./prompt-i18n.ts";
import {
  PROMPT_MARKER_KEYS,
  allPromptMarkers,
  forgedMarker,
  plainPromptText,
  safetyReason,
  safetyText,
  defaultSectionText,
  orgEditableKey,
  residentPromptSections,
  type ResidentPromptConfig,
} from "./resident-prompt.ts";
/**
 * what Daisy appends to an Agent's system layer (Claude Code's
 * appended system prompt, Codex's developer instructions), in four layers
 * — one pure function for the control plane (which sends the text with
 * every job as `guide`) and for tests:
 *
 *   1. org     — the organisation's boot core (an L1 document a plugin
 *                names, hook 1), read by the control plane or the
 *                owner's Runner and reported to it;
 *   2. session — what this kind of session is and how it works (Daisy's
 *                text, plus facts written from its settings);
 *   3. owner   — its owner's own words;
 *   4. safety  — the read-only rules. Always last.
 *
 * No hashing library here (this file is shared with the App): callers pass
 * `hash` (hex SHA-256).
 */
export type GuideHash = (text: string) => string;
export const GUIDE_VERSION = 2 as const;
export const GUIDE_LIMITS = {
  /** An owner's save is refused when the whole text would exceed this (and grow). */
  totalMax: 24_000,
  /** Never sent longer than this: trimmed (never the red lines or the safety rules). */
  hardMax: 48_000,
  /** The org core is injected whole up to this; above, only its locked parts. */
  orgMax: 16_000,
  /** What a Runner may report as the org core (UTF-8 bytes). */
  orgBytesMax: 65_536,
  /** 「个人补充说明」 / 「本会话补充」. */
  noteMax: 2_000,
  /** A cached core older than this says so in its marker line. */
  staleMs: 7 * 86_400_000,
} as const;
/**
 * 「Harbor 注入」: the mark of text the product injected. A contract with
 * the organisation's startup core (its text keys on these exact words), so it keeps
 * the old name; P0-06 did not change it (see names.ts). ADR-154 (D-43):
 * still written as it is; a reader accepts either spelling
 * (`INJECT_MARKS`), so a core that moves to 「Daisy 注入」 keeps working.
 */
export const INJECT_MARK = "Harbor 注入";
/** Every spelling of the mark a reader accepts (the written one first). */
export const INJECT_MARKS = [INJECT_MARK, `${PRODUCT_NAME} 注入`] as const;
/**
 * Layer markers, in the session's language (P6-24: `prompt-guide.*`). The
 * org head holds INJECT_MARK in every language: the core's own text keys on it.
 */
export const orgHeadPrefix = (t: PromptT) => t(PROMPT_MARKER_KEYS[0]);
export const orgEnd = (t: PromptT) => t("prompt-guide.org.end");
export const orgMissing = (t: PromptT) => t("prompt-guide.org.missing");
export const sessionHead = (t: PromptT) => t(PROMPT_MARKER_KEYS[1]);
export const ownerHead = (t: PromptT) => t("prompt-guide.owner.head");
/**
 * Text Daisy did not write (task titles, older stored sections) on its way
 * into the system layer: a line that would read as a layer marker no longer
 * starts like one.
 */
export function defang(text: string): string {
  const raw = String(text || "");
  // Nothing imitates a marker (the usual case): the text as it is.
  if (!forgedMarker(raw)) return raw;
  const markers = allPromptMarkers();
  return plainPromptText(raw)
    .split("\n")
    .map((line) => {
      const t = line.trimStart();
      if (!markers.some((x) => t.startsWith(x))) return line;
      const zh = line.replace(/【/, "［").replace(/安全规则（只读/, "安全规则 (只读");
      const left = zh.trimStart();
      if (!markers.some((x) => left.startsWith(x))) return zh;
      // Another language's marker: a full-width bracket for an opening
      // bracket, else a quote mark in front.
      return /^\[/.test(left) ? zh.replace(/\[/, "［") : zh.replace(/^(\s*)/, "$1> ");
    })
    .join("\n");
}
/**
 * First line of the developer message a Runner adds to a Codex thread that
 * was started with another text (resume / fork keep the first one).
 */
export const guideUpdateHead = (t: PromptT) => t("prompt-guide.head.update", { mark: INJECT_MARK });
export const guideSidecarHead = (t: PromptT) => t("prompt-guide.head.sidecar", { mark: INJECT_MARK });
/** What a Runner read and reported (4.1–4.4): `level` = which fallback it is. */
export interface OrgGuideRecord {
  docId: string;
  /** L1 `version`; 0 when unknown (the local file). */
  version: number;
  sha256: string;
  body: string;
  fetchedAt: number;
  /** 1 read now · 2 a cache · 3 `~/CLAUDE.md` · 4 nothing. */
  level: 1 | 2 | 3 | 4;
  /**
   * Who vouches for the text: "control-plane" — the control plane read L1
   * itself; "runner" (or absent) — a Runner reported it and the control
   * plane could not read L1 to check it: used only because its SHA-256 is
   * the expected hash an admin typed in.
   */
  source?: "control-plane" | "runner";
  /**
   * The control plane's own copy, last checked more than a day ago (it
   * cannot read the organisation's platform now): still used, said to be out of date.
   */
  expired?: boolean;
}
export interface OrgSection {
  /** `org:intro` · `org:<8 hex of its title>` · `org:redlines` · `org:tail`. */
  key: string;
  title: string;
  text: string;
  /** Nobody changes it in Daisy (only an L1 proposal does). */
  locked: boolean;
}
/** The organisation's own word for its red lines section (its core is written in Chinese). */
const REDLINES = /红线/;
const normTitle = (t: string) =>
  t.replace(/（[^）]*）|\([^)]*\)/g, "").replace(/\s+/g, "");
/**
 * Is this text a boot core Daisy may inject: a `## 规则` part and a red
 * lines section it can find (a `### ` heading that says 「红线」 — the short
 * core's 「### 红线（…）」 and the long one's 「### 六条红线（…）」 alike)?
 * Anything else is not adopted, wherever it came from.
 */
export function looksLikeOrgCore(body: string): boolean {
  const b = String(body || "").replace(/\r\n/g, "\n");
  return /^## 规则\s*$/m.test(b) && /^### .*红线/m.test(b);
}
/**
 * Does the core know it may arrive through Daisy (the short core says
 * what a session with / without the 「Harbor 注入」 marker does)? The long
 * version before it does not: every session would still print the banner
 * and sync the local files — the layers may not be switched on for all.
 */
export function coreKnowsInjection(body: string): boolean {
  const b = String(body || "");
  return INJECT_MARKS.some((m) => b.includes(m));
}
/**
 * The core cut at its `### ` headings (4.3): everything before the first is
 * the intro (locked), a heading that says 「红线」 is the red lines (locked),
 * a later `## ` heading starts the tail (locked); the rest may be replaced
 * or switched off by a resident's owner. No red lines found → `redlines`
 * false and every part locked: better unchangeable than bypassed.
 */
export function splitOrg(
  body: string,
  hash: GuideHash,
  /** The language of the titles Daisy gives (the opening, an untitled end). */
  t: PromptT = promptT(LEGACY_LANG),
): { sections: OrgSection[]; redlines: boolean } {
  const lines = String(body || "")
    .replace(/\r\n/g, "\n")
    .split("\n");
  const chunks: { kind: "intro" | "h3" | "tail"; title: string; lines: string[] }[] =
    [{ kind: "intro", title: t("prompt-guide.org.introTitle"), lines: [] }];
  let fence = false,
    seenH3 = false,
    tail = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence && !tail) {
      const h3 = /^### (.+?)\s*$/.exec(line);
      if (h3) {
        seenH3 = true;
        chunks.push({ kind: "h3", title: h3[1], lines: [line] });
        continue;
      }
      if (seenH3 && /^## (?!#)/.test(line)) {
        tail = true;
        chunks.push({
          kind: "tail",
          title: line.replace(/^## /, "").trim() || t("prompt-guide.org.tailTitle"),
          lines: [line],
        });
        continue;
      }
    }
    chunks[chunks.length - 1].lines.push(line);
  }
  const redlines = chunks.some(
    (c) => c.kind === "h3" && REDLINES.test(normTitle(c.title)),
  );
  const used = new Map<string, number>();
  const sections: OrgSection[] = [];
  for (const c of chunks) {
    const text = c.lines.join("\n").trim();
    if (!text) continue;
    const red = c.kind === "h3" && REDLINES.test(normTitle(c.title));
    let key =
      c.kind === "intro"
        ? "org:intro"
        : c.kind === "tail"
          ? "org:tail"
          : red
            ? "org:redlines"
            : `org:${hash(normTitle(c.title)).slice(0, 8)}`;
    const n = (used.get(key) || 0) + 1;
    used.set(key, n);
    if (n > 1) key = `${key}:${n}`;
    sections.push({
      key,
      title: c.title,
      text,
      locked: !redlines || c.kind !== "h3" || red,
    });
  }
  return { sections, redlines };
}
/** Optional sections of an ordinary session (6.1): on / off only. */
export const PROMPT_OPTIONAL = [
  "collab",
  "workspace",
  "workstyle",
  "context",
] as const;
export type PromptOptional = (typeof PROMPT_OPTIONAL)[number];
export const PROMPT_OPTIONAL_DEFAULT: Record<PromptOptional, boolean> = {
  collab: true,
  workspace: true,
  workstyle: false,
  context: false,
};
/** Their titles (message keys: say them in the reader's language). */
export const PROMPT_OPTIONAL_TITLE_KEY: Record<PromptOptional, MessageKey> = {
  collab: "prompt-guide.optional.collab",
  workspace: "prompt-guide.optional.workspace",
  workstyle: "prompt-guide.optional.workstyle",
  context: "prompt-guide.optional.context",
};
/** A person's defaults for her ordinary sessions (`user_prompt_prefs`). */
export interface UserPromptPrefs {
  note: string;
  sections: Partial<Record<PromptOptional, boolean>>;
}
/** One session's own (`session.promptExtra`): what is absent follows the person's. */
export interface SessionPromptExtra {
  note?: string;
  sections?: Partial<Record<PromptOptional, boolean>>;
}
/**
 * The static timers note of an ordinary session (was `toolsNote`), naming
 * the tools as this conversation knows them (ADR-154).
 */
export function timersText(agent: string, toolNames: ToolNames = "daisy", t: PromptT = promptT(LEGACY_LANG)): string {
  const name = (n: string) => toolId(agent, n, toolNames);
  return t("prompt-guide.timers", {
    wakeup: name("wakeup"),
    cron: name("cron"),
    bash: name("bash"),
    monitor: name("monitor"),
    schedules: name("schedules"),
    cancel: name("cancel"),
  });
}
/** Shared-edit workspaces; the Runner's per-turn line is "\n" + this. */
export const sharedWorkspaceText = (t: PromptT) => t("prompt-guide.sharedWorkspace");
/** Read-only / snapshot sessions; the Runner's per-turn line is "\n" + this. */
export const readOnlyText = (t: PromptT) => t("prompt-guide.readOnly");
/** A 「只问」 sidecar's own note. */
export const sidecarGuideText = (t: PromptT) => t("prompt-guide.sidecarGuide");
export type GuideLayerName = "org" | "session" | "owner" | "safety";
export type GuideLayerState =
  | "default"
  | "overridden"
  | "disabled"
  | "locked"
  | "derived"
  | "custom";
/** The web UI names the layers and states itself (its `ui-prompts` area, P6-22). */
export interface GuideLayer {
  id: string;
  layer: GuideLayerName;
  title: string;
  state: GuideLayerState;
  /** Where the text comes from, in words. */
  source: string;
  /** Its owner may change it here (replace / switch off / write). */
  editable: boolean;
  /** Ordinary sessions: on / off only. */
  toggle?: boolean;
  lockedReason?: string;
  /** What goes in — for a disabled section, what would. */
  text: string;
  /** What 「恢复默认」 puts back (replaceable sections). */
  defaultText?: string;
  chars: number;
  sha256: string;
  /** An org section replaced by its owner, and L1 changed it since. */
  orgChanged?: boolean;
  /** A stored org override whose section L1 no longer has: kept, not used. */
  orphan?: boolean;
  /** Left out for length (never a locked part or the safety rules). */
  trimmed?: boolean;
}
/** `RunnerJob.guide`: the composed text and what an audit needs. */
export interface JobGuide {
  v: typeof GUIDE_VERSION;
  /** The whole system-layer text, composed by the control plane. */
  text: string;
  sha256: string;
  /**
   * The process key: everything but the org layer, plus the org epoch.
   * An L1 update alone leaves it (no restart); an owner's change or
   * 「立即生效」 changes it.
   */
  stable: string;
  org: Omit<OrgGuideRecord, "body"> | null;
  layers: Omit<GuideLayer, "text" | "defaultText" | "source" | "lockedReason">[];
  /** The static collaboration / workspace rules are in `text`: each turn adds one line. */
  staticRules: boolean;
  /** Claude: render the system prompt afresh (`--system-prompt-snapshot off`). */
  fresh: boolean;
}
export interface ComposedGuide extends Omit<JobGuide, "layers"> {
  kind: "ordinary" | "resident" | "sidecar";
  layers: GuideLayer[];
  chars: number;
}
export interface ComposeInput {
  session: Pick<
    Session,
    | "agent"
    | "kind"
    | "resident"
    | "task"
    | "workspaceMode"
    | "nativeId"
    | "nativeTools"
    | "sidecar"
    | "lang"
  > & { promptExtra?: SessionPromptExtra };
  /** What this session's node reported; null = nothing yet. */
  org: OrgGuideRecord | null;
  /** Its owner's defaults (ordinary sessions). */
  prefs?: UserPromptPrefs | null;
  /** The control plane's collaboration features; null = no communication here. */
  features: string[] | null;
  /** Daisy's tools are offered. */
  daisyTools: boolean;
  /**
   * ADR-154: the names they go by for this session (what its Runner
   * serves: `toolNamesFor`). Absent: by the session alone
   * (`sessionToolNames`), as a current Runner serves them.
   */
  toolNames?: ToolNames;
  /** Move the static collaboration / workspace rules up from each turn. */
  staticRules: boolean;
  fresh: boolean;
  /** Bumped by 「立即生效」. */
  epoch: number;
  now: number;
  hash: GuideHash;
  /**
   * P4-13: the shell command printing the org document's body (hook 1's
   * `orgCore.rawCommand`) — named where the org layer was trimmed.
   * Absent: the document's id only.
   */
  orgRawCommand?: string;
  /**
   * P6-17: how the organisation changes its core, in its own words (hook
   * 1's `orgCore.changeVia`, e.g. 「L1 议案」). Absent: generic wording.
   */
  orgChangeVia?: string;
}
const day = (ms: number, t: PromptT) => {
  const d = new Date(ms);
  return t("prompt-guide.day", { month: d.getMonth() + 1, day: d.getDate() });
};
/**
 * Why a Runner's read of the boot core from the organisation's platform did not work — a code
 * out of this list, never free text: what a node says of itself is shown
 * to admins next to the field they type the expected hash into, and
 * nothing a holder of a node token writes may end up there. The control
 * plane maps a code to these fixed words; anything else is `other`.
 */
export const ORG_READ_REASON_KEY = {
  "no-socket": "prompt-guide.orgRead.no-socket",
  unreachable: "prompt-guide.orgRead.unreachable",
  denied: "prompt-guide.orgRead.denied",
  "not-found": "prompt-guide.orgRead.not-found",
  timeout: "prompt-guide.orgRead.timeout",
  "read-failed": "prompt-guide.orgRead.read-failed",
  "not-active": "prompt-guide.orgRead.not-active",
  empty: "prompt-guide.orgRead.empty",
  "too-large": "prompt-guide.orgRead.too-large",
  "not-core": "prompt-guide.orgRead.not-core",
  "bad-doc-id": "prompt-guide.orgRead.bad-doc-id",
  other: "prompt-guide.orgRead.other",
} as const satisfies Record<string, MessageKey>;
export type OrgReadReason = keyof typeof ORG_READ_REASON_KEY;
/** A reported reason as a known code: "" (none), a code of the list, else "other". */
export function orgReadReason(x: unknown): OrgReadReason | "" {
  if (x === undefined || x === null || x === "") return "";
  return typeof x === "string" && Object.hasOwn(ORG_READ_REASON_KEY, x)
    ? (x as OrgReadReason)
    : "other";
}
/** What stands where the version does when the text is only a Runner's report. */
export const orgHashChecked = (t: PromptT) => t("prompt-guide.org.hashChecked");
/**
 * The org layer's first line (holds 「Harbor 注入」).
 *
 * Read by the control plane itself: the document's version as the control
 * plane read it (and, for its older copy, when that was). Only a Runner's
 * report (used because its SHA-256 is the admin's expected hash): the
 * first 8 digits of the text's own hash and a fixed word — never the
 * version, the level or a date a node reported: those are a node's word,
 * and anyone holding a node token could change this line (and with it
 * every session's system-layer text) by reporting other ones.
 */
export function orgHead(
  org: Pick<
    OrgGuideRecord,
    "docId" | "version" | "level" | "fetchedAt" | "source" | "sha256"
  >,
  now: number,
  sidecar = false,
  t: PromptT = promptT(LEGACY_LANG),
): string {
  const side = sidecar ? t("prompt-guide.org.head.sidecar") : "";
  const close = t("prompt-guide.org.head.close");
  if (org.source !== "control-plane")
    return (
      `${orgHeadPrefix(t)} · ${INJECT_MARK} · ${org.docId} sha ${org.sha256.slice(0, 8)} · ${orgHashChecked(t)}` +
      side +
      close
    );
  return (
    `${orgHeadPrefix(t)} · ${INJECT_MARK} · ${org.docId}` +
    (org.version > 0 ? ` v${org.version}` : "") +
    (org.level === 3 ? t("prompt-guide.org.head.local") : "") +
    side +
    close +
    (org.level === 2 && now - org.fetchedAt > GUIDE_LIMITS.staleMs
      ? t("prompt-guide.org.head.stale", { day: day(org.fetchedAt, t) })
      : "")
  );
}
/**
 * P6-17: the org core's wording is generic (an organisation-provided
 * startup core); a plugin may name how its organisation changes it
 * (`orgChangeVia`, e.g. 「L1 议案」). P6-24: a Latin edge of that name
 * next to a Han character of the sentence gets a space.
 */
const HAN = /\p{Script=Han}/u;
function withVia(t: PromptT, key: "prompt-guide.org.lockVia" | "prompt-guide.org.privateVia", word: string): string {
  const tpl = t.dynamic(key);
  const at = tpl.indexOf("{via}");
  const pad =
    (at > 0 && HAN.test(tpl[at - 1]!) && /^[\x21-\x7e]/.test(word) ? " " : "") +
    word +
    (HAN.test(tpl[at + 5] ?? "") && /[\x21-\x7e]$/.test(word) ? " " : "");
  return t.dynamic(key, { via: pad });
}
const orgLockReason = (t: PromptT, changeVia?: string) =>
  t("prompt-guide.org.lockReason", {
    how: changeVia ? withVia(t, "prompt-guide.org.lockVia", changeVia) : t("prompt-guide.org.lockByOrg"),
  });
const orgPrivateReason = (t: PromptT, changeVia?: string) =>
  t("prompt-guide.org.privateReason", {
    how: changeVia ? withVia(t, "prompt-guide.org.privateVia", changeVia) : t("prompt-guide.org.privateByOrg"),
  });
/** Only the owner's Runner said so: shown as that, never as 「已核实」. */
export const orgUnverified = (t: PromptT) => t("prompt-guide.org.unverified");
const usable = (org: OrgGuideRecord | null): org is OrgGuideRecord =>
  !!org && org.level !== 4 && !!org.body.trim();
/**
 * The four layers of one session, composed. Never throws on odd input: a
 * missing or oversized core degrades (see `ORG_MISSING`, `orgMax`), the
 * safety rules are always the last paragraph.
 */
export function composeGuide(i: ComposeInput): ComposedGuide {
  const s = i.session,
    hash = i.hash,
    kind: ComposedGuide["kind"] = s.sidecar
      ? "sidecar"
      : s.kind === "resident" && s.resident
        ? "resident"
        : "ordinary";
  const p: ResidentPromptConfig | undefined =
    kind === "resident" ? s.resident!.prompt : undefined;
  const disabled = new Set(p?.disabled || []);
  // ADR-154: the names this conversation knows Daisy's tools by.
  const toolNames = i.toolNames ?? sessionToolNames(s);
  // P6-24: the session's language, for its whole life.
  const t = promptT(sessionLang(s));
  const layers: GuideLayer[] = [];
  const add = (
    l: Omit<GuideLayer, "chars" | "sha256"> & { text: string },
  ): GuideLayer => {
    const x = { ...l, chars: l.text.length, sha256: hash(l.text) };
    layers.push(x);
    return x;
  };
  // ── 1. org ──────────────────────────────────────────────────────────
  let orgHeadLine = orgMissing(t);
  const cut0 = usable(i.org) ? splitOrg(i.org.body, hash, t) : null;
  // Even its locked parts are too long to send (not a boot core at all):
  // as if nothing was read — the local files still hold it.
  // …and one without a red lines section is not a core Daisy injects:
  // never sent as if it had none.
  const org =
    usable(i.org) &&
    cut0!.redlines &&
    cut0!.sections
      .filter((x) => x.locked)
      .reduce((n, x) => n + x.text.length, 0) <= GUIDE_LIMITS.orgMax
      ? i.org
      : null;
  if (org) {
    const cut = cut0!;
    const whole = org.body.length <= GUIDE_LIMITS.orgMax;
    const verified = org.source === "control-plane";
    orgHeadLine = orgHead(org, i.now, kind === "sidecar", t);
    const seen = new Set<string>();
    for (const sec of cut.sections) {
      seen.add(sec.key);
      // A sidecar: the intro and the red lines only (2).
      if (kind === "sidecar" && !["org:intro"].includes(sec.key) && !/^org:redlines/.test(sec.key))
        continue;
      const mayEdit = kind === "resident" && !sec.locked;
      const own = mayEdit ? p?.overrides?.[sec.key] : undefined;
      const off = mayEdit && disabled.has(sec.key);
      add({
        id: sec.key,
        layer: "org",
        title: sec.title,
        state: sec.locked
          ? "locked"
          : off
            ? "disabled"
            : own
              ? "overridden"
              : "default",
        source: own
          ? t("prompt-guide.source.ownerRewrite", {
              doc: org.docId,
              ver: verified ? (org.version ? ` v${org.version}` : "") : ` sha ${org.sha256.slice(0, 8)}`,
            })
          : verified
            ? t("prompt-guide.source.verified", {
                doc: org.docId,
                ver: org.version ? ` v${org.version}` : "",
                how: t(org.expired ? "prompt-guide.source.verifiedExpired" : "prompt-guide.source.verifiedDirect"),
              })
            : `${org.docId} sha ${org.sha256.slice(0, 8)} · ${orgUnverified(t)}`,
        editable: mayEdit,
        ...(sec.locked || kind !== "resident"
          ? {
              lockedReason:
                (kind !== "resident"
                  ? orgPrivateReason(t, i.orgChangeVia)
                  : orgLockReason(t, i.orgChangeVia)) +
                (verified ? "" : t("prompt-guide.org.unverifiedReason")),
            }
          : {}),
        text: own ? defang(own) : sec.text,
        ...(mayEdit ? { defaultText: sec.text } : {}),
        ...(own && p?.orgBase?.[sec.key] && p.orgBase[sec.key] !== hash(sec.text)
          ? { orgChanged: true }
          : {}),
        // Too long to send whole: the locked parts stay, the rest is fetched.
        ...(!whole && !sec.locked ? { trimmed: true } : {}),
      });
    }
    // Stored overrides whose section this version no longer has.
    if (kind === "resident")
      for (const [k, v] of Object.entries(p?.overrides || {}))
        if (orgEditableKey(k) && !seen.has(k) && v)
          add({
            id: k,
            layer: "org",
            title: t("prompt-guide.orphan.title"),
            state: "overridden",
            source: t("prompt-guide.orphan.source"),
            editable: false,
            lockedReason: t("prompt-guide.orphan.reason"),
            text: v,
            orphan: true,
          });
  } else
    add({
      id: "org:missing",
      layer: "org",
      title: t("prompt-guide.missing.title"),
      state: "locked",
      source: t("prompt-guide.missing.source"),
      editable: false,
      lockedReason: t("prompt-guide.missing.reason"),
      text: orgMissing(t),
    });
  // ── 2. session ──────────────────────────────────────────────────────
  const session = (
    l: Omit<GuideLayer, "chars" | "sha256" | "layer">,
  ) => add({ ...l, layer: "session" });
  // P4N-3: Daisy's tools this session's Codex thread lacks (none for a
  // new thread, another engine, or no tools at all).
  const missing = missingThreadTools(
    s,
    i.daisyTools && kind !== "sidecar" ? daisyToolNames(s.kind) : [],
  );
  const readOnly = ["read-only", "snapshot"].includes(s.workspaceMode || "");
  const shared = (s.workspaceMode || "shared") === "shared";
  // P1-01: the collaboration rules were the 群聊 CLI's; there is none now
  // (stage 4 adds the A2A tools' rules here).
  const collabDefault: string = "";
  if (kind === "sidecar")
    session({
      id: "sidecar",
      title: t("prompt-guide.sidecar.title"),
      state: "locked",
      source: t("prompt-guide.source.builtin"),
      editable: false,
      lockedReason: t("prompt-guide.sidecar.reason"),
      text: sidecarGuideText(t),
    });
  else if (kind === "resident") {
    // The owner's settings as text, with her replacements.
    for (const x of residentPromptSections(
      {
        ...s,
        resident: { ...s.resident!, prompt: p && { ...p, disabled: [] } },
      },
      { toolNames },
    )) {
      if (x.kind === "custom" || x.id === "safety") continue;
      const off = x.kind === "default" && disabled.has(x.id);
      session({
        id: x.id,
        title: x.title,
        state:
          x.kind === "derived"
            ? "derived"
            : off
              ? "disabled"
              : x.overridden
                ? "overridden"
                : "default",
        source: x.source,
        editable: x.kind === "default",
        ...(x.reason ? { lockedReason: x.reason } : {}),
        // Derived text carries task titles: not Daisy's words.
        text: defang(x.text),
        ...(x.defaultText ? { defaultText: x.defaultText } : {}),
      });
    }
    const extra = (id: "collab" | "workspace", title: string, def: string) => {
      const own = p?.overrides?.[id];
      session({
        id,
        title,
        state: disabled.has(id) ? "disabled" : own ? "overridden" : "default",
        source: t(own ? "prompt-guide.source.ownerChanged" : "prompt-guide.source.defaultPerTurn"),
        editable: true,
        text: own ? defang(own) : def,
        defaultText: def,
      });
    };
    if (i.staticRules && collabDefault)
      extra("collab", t.dynamic(PROMPT_OPTIONAL_TITLE_KEY.collab), collabDefault);
    if (i.staticRules && shared)
      extra("workspace", t.dynamic(PROMPT_OPTIONAL_TITLE_KEY.workspace), sharedWorkspaceText(t));
  } else {
    const on = (k: PromptOptional) =>
      s.promptExtra?.sections?.[k] ??
      i.prefs?.sections?.[k] ??
      PROMPT_OPTIONAL_DEFAULT[k];
    // Codex keeps Daisy's tools with the thread: one started without has
    // none (P4N-3: nor the ones added after it started).
    const tools = i.daisyTools && !missing.names.includes("wakeup");
    if (tools)
      session({
        id: "timers",
        title: t("prompt-guide.timers.title"),
        state: "locked",
        source: t("prompt-guide.source.builtin"),
        editable: false,
        lockedReason: t("prompt-guide.timers.reason"),
        text: timersText(s.agent, toolNames, t),
      });
    const optional = (k: PromptOptional, text: string) =>
      session({
        id: k,
        title: t.dynamic(PROMPT_OPTIONAL_TITLE_KEY[k]),
        state: on(k) ? "default" : "disabled",
        source: t("prompt-guide.source.defaultToggle"),
        editable: false,
        toggle: true,
        text,
      });
    if (i.staticRules && collabDefault) optional("collab", collabDefault);
    if (i.staticRules && shared) optional("workspace", sharedWorkspaceText(t));
    optional(
      "workstyle",
      // No `say` in an ordinary session.
      defaultSectionText("workstyle", s.agent, toolNames, undefined, t, { say: false }),
    );
    optional("context", defaultSectionText("context", s.agent, toolNames, undefined, t));
  }
  if (kind !== "sidecar" && missing.names.length)
    session({
      id: "tools-missing",
      title: t("prompt-guide.toolsMissing.title"),
      state: "derived",
      source: t("prompt-guide.toolsMissing.source"),
      editable: false,
      lockedReason: t("prompt-guide.toolsMissing.reason"),
      text: missingToolsText(missing, toolNames, t),
    });
  if (kind !== "sidecar" && i.staticRules && readOnly)
    session({
      id: "readonly",
      title: t("prompt-guide.readOnly.title"),
      state: "derived",
      source: t("prompt-guide.readOnly.source"),
      editable: false,
      lockedReason: t("prompt-guide.readOnly.reason"),
      text: readOnlyText(t),
    });
  // ── 3. owner ────────────────────────────────────────────────────────
  if (kind === "resident")
    for (const c of p?.custom || [])
      add({
        id: `custom:${c.id}`,
        layer: "owner",
        title: c.title,
        state: "custom",
        source: t("prompt-guide.source.custom"),
        editable: true,
        text: defang(c.text),
      });
  else if (kind === "ordinary") {
    const mine = (i.prefs?.note || "").trim(),
      here = (s.promptExtra?.note || "").trim();
    if (mine)
      add({
        id: "note:user",
        layer: "owner",
        title: t("prompt-guide.note.user.title"),
        state: "custom",
        source: t("prompt-guide.note.user.source"),
        editable: true,
        text: defang(mine),
      });
    if (here)
      add({
        id: "note:session",
        layer: "owner",
        title: t("prompt-guide.note.session.title"),
        state: "custom",
        source: t("prompt-guide.note.session.source"),
        editable: true,
        text: defang(here),
      });
  }
  // ── 4. safety ───────────────────────────────────────────────────────
  add({
    id: "safety",
    layer: "safety",
    title: t("prompt-guide.safety.title"),
    state: "locked",
    source: t("prompt-guide.source.builtinReadOnly"),
    editable: false,
    lockedReason: safetyReason(t),
    text: safetyText(t),
  });
  // ── length: never the locked org parts, derived facts or the safety rules ──
  const live = (x: GuideLayer) =>
    x.state !== "disabled" && !x.orphan && !x.trimmed;
  const orgTrimmed = org ? orgTrimmedText(t, org.docId, i.orgRawCommand) : "";
  const total = () =>
    render(layers, orgHeadLine, !!org, live, orgTrimmed, t).length;
  if (total() > GUIDE_LIMITS.hardMax) {
    const order = [
      ...layers.filter((x) => x.layer === "org" && x.state !== "locked").reverse(),
      ...layers.filter((x) => x.toggle).reverse(),
      ...layers.filter((x) => x.layer === "owner").reverse(),
      ...layers
        .filter((x) => x.layer === "session" && x.editable)
        .reverse(),
    ];
    for (const x of order) {
      if (total() <= GUIDE_LIMITS.hardMax) break;
      if (live(x)) x.trimmed = true;
    }
  }
  const text = render(layers, orgHeadLine, !!org, live, orgTrimmed, t);
  const rest = layers
    .filter((x) => x.layer !== "org" && live(x))
    .map((x) => x.text)
    .join("\n\n");
  const orgOwn =
    kind === "resident"
      ? Object.entries(p?.overrides || {})
          .filter(([k]) => orgEditableKey(k))
          .map(([k, v]) => [k, hash(v || "")])
          .concat([...disabled].filter(orgEditableKey).map((k) => [k, "off"]))
          .sort((a, b) => (a[0] + a[1] < b[0] + b[1] ? -1 : 1))
      : [];
  return {
    v: GUIDE_VERSION,
    kind,
    text,
    chars: text.length,
    sha256: hash(text),
    stable: hash(
      JSON.stringify([
        GUIDE_VERSION,
        i.epoch,
        i.fresh,
        i.staticRules,
        kind,
        rest,
        orgOwn,
      ]),
    ).slice(0, 16),
    org: i.org
      ? {
          docId: i.org.docId,
          version: i.org.version,
          sha256: i.org.sha256,
          fetchedAt: i.org.fetchedAt,
          level: org ? i.org.level : 4,
          source: i.org.source === "control-plane" ? "control-plane" : "runner",
          ...(i.org.expired ? { expired: true } : {}),
        }
      : null,
    layers,
    // A sidecar has no collaboration CLI and no per-turn rules to shorten.
    staticRules: kind !== "sidecar" && i.staticRules,
    fresh: i.fresh,
  };
}
const orgTrimmedText = (t: PromptT, docId: string, rawCommand?: string) =>
  rawCommand
    ? t("prompt-guide.org.trimmedRaw", { raw: rawCommand })
    : t("prompt-guide.org.trimmedDoc", { doc: docId });
function render(
  layers: GuideLayer[],
  orgHeadLine: string,
  hasOrg: boolean,
  live: (x: GuideLayer) => boolean,
  orgTrimmed: string,
  t: PromptT,
): string {
  const of = (l: GuideLayerName) => layers.filter((x) => x.layer === l);
  const texts = (l: GuideLayerName) =>
    of(l)
      .filter(live)
      .map((x) => x.text);
  const orgCut = of("org").some((x) => x.trimmed);
  const orgBlock = hasOrg
    ? [
        orgHeadLine,
        [...texts("org"), ...(orgCut ? [orgTrimmed] : [])].join("\n\n"),
        orgEnd(t),
      ].join("\n")
    : orgHeadLine;
  const sessionTexts = texts("session"),
    ownerTexts = texts("owner");
  return [
    orgBlock,
    sessionTexts.length ? `${sessionHead(t)}\n${sessionTexts.join("\n\n")}` : "",
    ownerTexts.length ? `${ownerHead(t)}\n${ownerTexts.join("\n\n")}` : "",
    texts("safety").join("\n\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
}
/** `RunnerJob.guide` of a composed guide (no section texts but the whole). */
export function jobGuide(g: ComposedGuide): JobGuide {
  return {
    v: g.v,
    text: g.text,
    sha256: g.sha256,
    stable: g.stable,
    org: g.org,
    layers: g.layers.map(
      ({ text: _t, defaultText: _d, source: _s, lockedReason: _r, ...x }) => x,
    ),
    staticRules: g.staticRules,
    fresh: g.fresh,
  };
}
/** `GET /api/sessions/:id/prompt` : what one session really gets — its owner only. */
export interface SessionPromptView {
  kind: ComposedGuide["kind"];
  agent: string;
  /** Is the layered prompt what this session's Runner gets? If not, why. */
  layered: { on: boolean; why?: string };
  layers: GuideLayer[];
  /** The composed system-layer text (what is sent when `layered.on`). */
  text: string;
  chars: number;
  max: number;
  /** What each turn's message gets added by the Runner, as it is now. */
  perTurn: { title: string; text: string; note?: string }[];
  /** Daisy's tools as the Agent sees them. */
  tools: { name: string; description: string }[];
  /** The engine's own, which Daisy does not show. */
  engineOwned: string[];
  org: ComposedGuide["org"];
  /**
   * Present when the core is not what the control plane reads now: what a
   * Runner reported (used because its hash is the admin's expected hash),
   * or the control plane's copy that is out of date. Say it.
   */
  orgNote?: string;
  /** @deprecated always false: a core without a red lines section is not adopted. */
  orgLocked: boolean;
  /** The newest 「启动提示词审计」 of this session (Runner), if any. */
  lastLaunch: Record<string, unknown> | null;
  /**
   * Is the composed text what the Runner last reported in this
   * conversation's system layer? "unknown": never reported (an older
   * conversation, or the layers are off).
   */
  effective: "yes" | "stale" | "unknown";
  /** `effective` in words: 已生效 / 待生效（等压缩）/ 未确认. */
  effectiveText: string;
  delivered: { sha256: string; at: number } | null;
  /** "next-start": at the next process start · "after-compact": only after a compaction. */
  effect: "next-start" | "after-compact";
  effectText: string;
  /**
   * 「立即压缩并生效」 for this session: can it be asked for now, and where
   * a request stands. Compacting makes the engine take the current text.
   */
  apply: {
    available: boolean;
    state?: "waiting" | "running" | "done" | "failed" | "skipped" | "cancelled";
    note?: string;
  };
  /** Ordinary sessions: this session's own, its owner's defaults, each switch as it results. */
  extra?: SessionPromptExtra;
  prefs?: UserPromptPrefs;
  optional?: {
    key: PromptOptional;
    title: string;
    on: boolean;
    /** This session's own setting; null = follows the person's. */
    own: boolean | null;
  }[];
  limits: { noteMax: number; totalMax: number };
  history: { at: number; by: string; action: string; summary: string }[];
}
/** `GET / PUT /api/me/prompt`: a person's defaults for her ordinary sessions. */
export interface MyPromptView {
  note: string;
  sections: Record<PromptOptional, boolean>;
  optional: { key: PromptOptional; title: string; default: boolean }[];
  limits: { noteMax: number };
  history: { at: number; by: string; action: string; summary: string }[];
}
/** `PUT /api/me/prompt`; a switch set to null goes back to Daisy's default. */
export interface MyPromptUpdate {
  note?: string;
  sections?: Partial<Record<PromptOptional, boolean | null>>;
}
/** `PUT /api/sessions/:id/prompt/extra`; null = follow the person's default. */
export interface SessionPromptExtraUpdate {
  note?: string | null;
  sections?: Partial<Record<PromptOptional, boolean | null>>;
}
/** The switch (admins): who gets the layered prompt, and how. */
export interface PromptLayerSettings {
  /** off: nobody · allowlist: `sessions` / `users` · all. */
  mode: "off" | "allowlist" | "all";
  sessions: string[];
  users: string[];
  /** The static collaboration / workspace rules go into the system layer. */
  staticRules: boolean;
  /**
   * An experiment, off by default: Claude Code renders its system prompt
   * afresh at every request (`--system-prompt-snapshot off`) for the
   * sessions / people in `freshList` — a change then lands at the next
   * process start instead of the next compaction. Its cost on long
   * sessions is not measured.
   */
  claudeFresh: boolean;
  freshList: string[];
  /** Runners read and report the boot core — only while `mode` is not off. */
  orgRead: boolean;
  /** Bumped by 「立即生效」. */
  epoch: number;
  /**
   * The SHA-256 of the boot core's body (64 hex digits; "" = none),
   * computed by an admin herself from L1 and typed in — never taken from
   * what a node reported. Where the control plane cannot read L1 itself,
   * a reported text is used only when its hash is this one; the pilot
   * list cannot be switched on without it. Not used while the control
   * plane reads L1 itself. `orgExpectedBy` / `orgExpectedAt`: who typed
   * it in (a user id) and when.
   */
  orgExpected: string;
  orgExpectedBy?: string;
  orgExpectedAt?: number;
}
/** `GET / PUT /api/admin/prompt-layers`. */
export interface PromptLayerAdminView {
  settings: PromptLayerSettings;
  docId: string;
  /**
   * The boot core the control plane goes by: read by itself
   * ("control-plane", checked); or a Runner's report whose hash is the
   * expected hash ("runner"); or nothing yet ("none": also when no node
   * has reported the text with the expected hash).
   */
  core: {
    source: "control-plane" | "runner" | "none";
    version: number;
    sha256: string;
    fetchedAt: number;
    /** Why the control plane's own read does not work ("" = it does). */
    problem: string;
    /** It says what a 「Harbor 注入」 session does: `mode: "all"` needs that. */
    knowsInjection: boolean;
    /**
     * "control-plane" only: its last good read is more than a day old —
     * still what sessions get, but `mode: "all"` is not allowed on it.
     */
    expired?: boolean;
  };
  nodes: {
    id: string;
    label: string;
    /** P6-28: the label is Daisy's default node name (`shownName("node", …)`). */
    labelDefault?: boolean;
    lastSeen: number;
    /** Heard from in the last 24 hours (only such nodes are compared and alerted). */
    active: boolean;
    /** Its Runner takes the layered prompt. */
    promptLayers: boolean;
    /** The release its Runner process loaded. */
    release: string | null;
    org: {
      docId: string;
      /**
       * The first 12 digits of the hash of the text it reported ("" =
       * none yet). Never the whole hash: nothing a node reports may be
       * something to copy into the expected hash.
       */
      sha256: string;
      reportedAt: number;
      /**
       * Is the text it last reported the one in use — the control plane's
       * own, else the one with the expected hash? Decided by the control
       * plane. (Its text is never shown: one that does not match is not
       * to be trusted, one that does is L1.)
       */
      accepted: boolean;
      /** Why not, in the control plane's words. */
      problem?: string;
      /**
       * What the node said of itself (「节点自述」, unchecked — and never
       * used for anything a session gets): the version and level it
       * claims, and why its read of the organisation's platform did not work — a code of
       * `ORG_READ_REASONS` with its fixed words, never free text.
       */
      self: {
        version: number;
        level: number;
        reason?: OrgReadReason;
        reasonText?: string;
      };
      /** Changes not written to the log (more than the hourly number). */
      logDropped?: number;
    } | null;
  }[];
  /** Nodes whose core differs from the reference (or from each other). */
  inconsistent: string[];
  /** In words, for the page: what needs an admin's eye. */
  alerts: string[];
  /**
   * Newest changes of the core's text (who reported, before → after). The
   * hashes of a Runner's lines are cut to 12 digits (as `nodes[].org`).
   */
  log: {
    at: number;
    source: string;
    nodeId: string | null;
    version: number;
    before: string;
    after: string;
    accepted: boolean;
    note: string;
  }[];
  /** 「立即生效」: sessions waiting for / in their compaction. */
  apply: {
    waiting: number;
    running: number;
    done: number;
    skipped: number;
    /**
     * Conversations of an admin's 「立即生效」 still waiting or being
     * compacted: while not 0, another one is refused (409)…
     */
    batch?: number;
    /** …and those of them that have not started (what `apply-cancel` drops). */
    batchWaiting?: number;
  };
  /** People a pilot list may cover while the control plane cannot read L1 itself. */
  pilotMax?: number;
  /** The command an admin computes the expected hash with, herself. */
  verifyHint?: string;
  /**
   * The expected hash now in the settings (null: none): by whom, when,
   * and whether any node has reported the text with that hash yet.
   */
  expected?: { sha256: string; by: string; at: number; seen: boolean } | null;
  /** `POST …/apply-now` confirmed with nothing to compact: nothing was done. */
  noop?: boolean;
  /**
   * `POST …/apply-now`: what it would compact (without `confirm`) or did
   * (with): conversations and people within the limit, how many are over
   * it. Without `confirm` also the `token` the confirmation must carry
   * (this admin's, for exactly these conversations, good once until
   * `expiresAt`).
   */
  estimate?: {
    sessions: number;
    owners: number;
    limit: number;
    total: number;
    truncated: number;
    /** How many start at once when confirmed (one per node) and cannot be cancelled. */
    immediate?: number;
    people: { username: string; sessions: number }[];
    token?: string;
    expiresAt?: number;
  };
  /** `POST …/apply-cancel`: how many waiting ones of the admin's batch were dropped… */
  cancelled?: number;
  /** …and how many were already being compacted (they finish). */
  stillRunning?: number;
  /** This save: list entries dropped because the session / person is gone. */
  pruned?: { sessions: string[]; users: string[]; freshList: string[] };
  /** This save: what the admin should know (e.g. a pilot on the long core). */
  warnings?: string[];
}
