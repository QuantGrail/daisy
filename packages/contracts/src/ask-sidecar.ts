import type { Lang } from "./i18n.ts";
import { LEGACY_PROMPT_LANG, promptForms, promptT } from "./prompt-i18n.ts";
/**
 * 「只问」 (askOnly) sidecars: a question to an AI that must not wake
 * its main session. Daisy forks a read-only sidecar from the main
 * session's context, the sidecar answers the question, and a compact
 * summary rides the main session's next turn. P1-01: the 群聊 routing and
 * its UI words went with 群聊; stage 4 routes 「问」 from the A2A entry.
 *
 * Shared by the control plane (parsing, summary), the Runner (read-only
 * launch settings, side questions).
 */

/** Limits (control plane; env overrides in packages/daisy/src/sessions/ask-sidecar.ts). */
export const ASK_SIDECAR = {
  /** Sidecar turns queued / running at once per main session. */
  concurrent: 2,
  /** Sidecar turns per main session per 24 hours. */
  daily: 30,
  /** A sidecar unused this long is closed (the next ask forks a new one). */
  idleMs: 24 * 3600_000,
  /** The summary body the sidecar is asked for (Chinese characters). */
  summaryMin: 200,
  summaryMax: 500,
  /** Hard cap of one summary (fixed header included). */
  summaryCap: 800,
  /** At most this much summary text rides one main turn; the rest waits. */
  carryCap: 6000,
  /** Summaries older than this are dropped undelivered. */
  keepMs: 7 * 86400_000,
} as const;

/** Providers that can fork a native session (Claude Code, Codex). */
export const ASK_SIDECAR_AGENTS = ["claude", "codex"] as const;

/**
 * The line between the answer (posted) and the summary (for the main
 * session), in the session's language (P6-24: was the constant
 * `ASK_SEPARATOR`, 「===给主线的摘要===」 — still the Chinese form).
 */
export const askSeparator = (lang: Lang = LEGACY_PROMPT_LANG) => promptT(lang)("prompt-ask.separator");
/** Every language's separator: what a reader looks for. */
export const askSeparators = () => promptForms("prompt-ask.separator");
/**
 * The last of `markers` in `text`: where and which (index -1: none). A
 * reader of a marker the model writes in its session's language accepts
 * them all.
 */
export function lastMarker(text: string, markers: readonly string[]): { at: number; marker: string } {
  let best = { at: -1, marker: "" };
  for (const m of markers) {
    const at = m ? text.lastIndexOf(m) : -1;
    if (at > best.at) best = { at, marker: m };
  }
  return best;
}

/** The summary fields the sidecar writes (谁 / 在哪 are Daisy's). */
export interface SidecarSummaryFields {
  asked: string;
  replied: string;
  /** 「无」 when the main session has nothing to do. */
  todo: string;
  background?: string;
}

const FIELD_KEYS: (keyof SidecarSummaryFields)[] = ["asked", "replied", "todo", "background"];
const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A summary field's label in any language (`prompt-ask.summary.label.*`). */
const fieldRe = (k: keyof SidecarSummaryFields) =>
  new RegExp(
    `^\\s*[-*·]?\\s*(?:${promptForms(`prompt-ask.summary.label.${k}`).map(escapeRe).join("|")})\\s*[:\\uFF1A]`,
    "i",
  );

/** 「无」 / 「没有」 / empty: nothing for the main session. */
export const nothingTodo = (t: string | undefined) =>
  !t || /^[\s（(]*(无|没有|暂无|none|n\/a)[\s。.）)]*$/i.test(t.trim());

/**
 * Split a sidecar's last words into the answer (returned to the asker) and
 * its summary fields. Without the separator the whole text is the answer
 * and the fields are left empty (Daisy fills them in mechanically).
 */
export function parseSidecarOutput(raw: string): {
  answer: string;
  fields: SidecarSummaryFields | null;
  needsMain: boolean;
} {
  const text = String(raw || "").trim();
  const { at, marker } = lastMarker(text, askSeparators());
  if (at < 0) return { answer: text, fields: null, needsMain: false };
  const answer = text.slice(0, at).trim();
  const rest = text.slice(at + marker.length).split("\n");
  const FIELD = Object.fromEntries(FIELD_KEYS.map((k) => [k, fieldRe(k)])) as Record<keyof SidecarSummaryFields, RegExp>;
  const fields: SidecarSummaryFields = { asked: "", replied: "", todo: "" };
  let cur: keyof SidecarSummaryFields | null = null;
  for (const line of rest) {
    const hit = FIELD_KEYS.find(
      (k) => FIELD[k].test(line),
    );
    if (hit) {
      cur = hit;
      fields[hit] = line.replace(FIELD[hit], "").trim();
      continue;
    }
    if (cur && line.trim())
      fields[cur] =
        `${fields[cur] || ""}${fields[cur] ? "\n" : ""}${line.trim()}`;
  }
  return {
    answer: answer || text.slice(0, at).trim(),
    fields,
    needsMain: !nothingTodo(fields.todo),
  };
}

const cut = (s: string, n: number) => {
  const t = String(s || "").trim();
  if (t.length <= n) return t;
  // Do not split a surrogate pair.
  let end = n - 1;
  const c = t.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end--;
  return t.slice(0, end) + "…";
};

/**
 * One summary for the main session, fixed fields in a fixed order; at most
 * `ASK_SIDECAR.summaryCap` characters. Without the sidecar's own fields
 * (it did not follow the format) the question and the answer are excerpted.
 */
export function sidecarSummary(o: {
  who: string;
  /** Where it was asked, one label Daisy composed (stage 4: the A2A conversation). */
  where: string;
  question: string;
  answer: string;
  fields: SidecarSummaryFields | null;
  /** The main session's language. */
  lang?: Lang;
}): string {
  const t = promptT(o.lang ?? LEGACY_PROMPT_LANG);
  const field = (k: keyof SidecarSummaryFields, value: string) =>
    t("prompt-ask.summary.field", { label: t.dynamic(`prompt-ask.summary.label.${k}`), value });
  const f = o.fields;
  const head = t("prompt-ask.summary.head", { who: cut(o.who, 80), where: cut(o.where, 100) });
  const asked = f?.asked || t("prompt-ask.summary.quote", { text: cut(o.question, 160) });
  const replied = f?.replied || cut(o.answer, 260);
  const todo = f ? f.todo || t("prompt-ask.summary.none") : t("prompt-ask.summary.noneExcerpt");
  const lines = [
    head,
    field("asked", asked),
    field("replied", replied),
    field("todo", todo),
    ...(f?.background ? [field("background", f.background)] : []),
  ];
  let out = lines.join("\n");
  if (out.length > ASK_SIDECAR.summaryCap) {
    // Trim the longest free-text fields first, keep the header whole.
    const room = ASK_SIDECAR.summaryCap - head.length - 40;
    const share = Math.max(60, Math.floor(room / (f?.background ? 4 : 3)));
    out = [
      head,
      field("asked", cut(asked, share)),
      field("replied", cut(replied, share)),
      field("todo", cut(todo, share)),
      ...(f?.background ? [field("background", cut(f.background, share))] : []),
    ].join("\n");
    out = cut(out, ASK_SIDECAR.summaryCap);
  }
  return out;
}

/** Why a question went to the main session after all. */
export type AskFallback = "disabled" | "unsupported" | "runner";

// ---------------------------------------------------------------------------
// 「只问」 natively where the agent can (contracts
// agent-capabilities.ts `askOnly`). Claude Code: control `side_question`
// against the main session's live process — it answers from the
// conversation in memory, with no tools, without interrupting a running
// turn and without entering the main history. Codex: a throwaway
// (`ephemeral`) read-only fork of the main thread per question. Either way
// Daisy keeps the earlier questions and answers (`AskHistory`)
// and hands them back: as `history` to side_question, as a quoted block to
// a fork that has not seen them.

/** How one 「只问」 turn was answered (the Runner reports it). */
export type AskVia = "side_question" | "ephemeral" | "fork";

/** One earlier question / answer of the conversation (oldest first). */
export interface AskHistoryEntry {
  question: string;
  response: string;
  via: AskVia;
  at: number;
}

/** Bounds of the history Daisy keeps per sidecar. */
export const ASK_HISTORY = {
  entries: 12,
  question: 4000,
  response: 8000,
  /** Total characters handed back to one question. */
  total: 40000,
} as const;

/** `history` with one more entry, within `ASK_HISTORY` (drops the oldest). */
export function askHistoryAdd(
  history: AskHistoryEntry[] | undefined,
  entry: AskHistoryEntry,
): AskHistoryEntry[] {
  const next = [
    ...(history || []),
    {
      ...entry,
      question: cut(entry.question, ASK_HISTORY.question),
      response: cut(entry.response, ASK_HISTORY.response),
    },
  ].slice(-ASK_HISTORY.entries);
  let size = next.reduce(
    (n, e) => n + e.question.length + e.response.length,
    0,
  );
  while (next.length > 1 && size > ASK_HISTORY.total) {
    const e = next.shift()!;
    size -= e.question.length + e.response.length;
  }
  return next;
}

/**
 * The fixed reply a side question gives when the conversation in memory
 * is not enough (files to read, commands to run…): Daisy then asks the
 * read-only sidecar instead. ASCII so no model re-renders it.
 */
export const ASK_NEEDS_FILES = "[[DAISY_NEEDS_FILES]]";
/**
 * ADR-154: what it said before (`[[HARBOR_NEEDS_FILES]]`) — a conversation
 * asked then may answer with it still; recognised as the same.
 */
export const ASK_NEEDS_FILES_LEGACY = "[[HARBOR_NEEDS_FILES]]";
const NEEDS_FILES =
  /\[\[\s*(?:DAISY|HARBOR)_NEEDS_FILES\s*\]\]|(?:DAISY|HARBOR)_NEEDS_FILES/gi;

/**
 * The question sent as `side_question`: Daisy's sidecar prompt (who asks,
 * authorisation, answer + summary format) under a short frame that says
 * what this route can and cannot do.
 */
export function sideQuestionText(prompt: string, lang: Lang = LEGACY_PROMPT_LANG): string {
  return promptT(lang)("prompt-ask.sideQuestion", { needsFiles: ASK_NEEDS_FILES }) + "\n\n" + prompt;
}

/**
 * The side question asked for files / commands (or gave no usable
 * answer): fall back to the forked sidecar. Robust to the marker being
 * quoted, bolded or surrounded by a word or two; a long answer that merely
 * mentions it is still an answer.
 */
export function sideQuestionNeedsFiles(answer: string | null | undefined) {
  const t = String(answer ?? "").trim();
  if (!t) return true;
  if (!t.match(NEEDS_FILES)) return false;
  const rest = t
    .replace(NEEDS_FILES, "")
    .replace(/[\s*`_"'“”「」。.:：]/g, "");
  return rest.length < 40;
}

/**
 * Text that cannot close (or open) the quote it is put in: `<` / `>` as
 * `\u003c` / `\u003e`, as the control plane's `clean()` quotes others' text.
 */
const quoteSafe = (t: string) =>
  String(t || "")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");

/**
 * Earlier questions the answering context has not seen
 * (a side question and Codex's per-question fork: all of them; Claude's
 * persisted fork: those answered some other way), quoted as external data
 * at the head of the prompt — never as conversation turns (review M1:
 * side_question `history` would render another person's words as the
 * owner's own turns). Empty: nothing to add.
 */
export function askHistoryBlock(entries: AskHistoryEntry[], lang: Lang = LEGACY_PROMPT_LANG): string {
  if (!entries.length) return "";
  const t = promptT(lang);
  return (
    t("prompt-ask.history.head", { count: entries.length }) +
    "\n" +
    entries
      .map(
        (e, i) =>
          `${t("prompt-ask.history.item", { n: i + 1 })}\n<external_message>\n${t("prompt-ask.history.qa", { question: quoteSafe(e.question), answer: quoteSafe(e.response) })}\n</external_message>`,
      )
      .join("\n") +
    "\n\n"
  );
}
