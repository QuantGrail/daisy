/**
 * Conversation titles (revised 2026-10-30): a
 * conversation may start untitled. Its first message gives an immediate
 * placeholder (the first sentence, not AI). After the second completed round
 * the Runner asks the user's own CLI, once, for one final title from the
 * first two rounds; a failure is retried once after round 3, then the
 * placeholder stays. There is no provisional AI title after round 1. A title
 * the user typed or renamed is never replaced.
 */
import { LEGACY_PROMPT_LANG, promptT } from "./prompt-i18n.ts";
import type { Lang } from "./i18n.ts";

/**
 * P6-24: the placeholder title of an untitled conversation, in the
 * session's language (`prompt-title.untitled`; was the constant
 * `UNTITLED`, 「新对话」).
 */
export const untitledTitle = (lang: Lang = LEGACY_PROMPT_LANG) => promptT(lang)("prompt-title.untitled");

/** Rough display width: CJK counts 2, the rest 1. */
function width(text: string) {
  let w = 0;
  for (const c of text) w += /[⺀-￿]/.test(c) ? 2 : 1;
  return w;
}

function cut(text: string, max: number) {
  if (width(text) <= max) return text;
  let out = "",
    w = 0;
  for (const c of text) {
    const cw = /[⺀-￿]/.test(c) ? 2 : 1;
    if (w + cw > max - 1) break;
    out += c;
    w += cw;
  }
  return out.trimEnd() + "…";
}

/**
 * Immediate title from the first message: its first meaningful line without
 * markdown / mention noise, at most ~20 CJK or ~40 Latin characters.
 */
export function fallbackTitle(text: string, lang: Lang = LEGACY_PROMPT_LANG) {
  const line =
    text
      .split(/\r?\n/)
      .map((l) =>
        l
          .replace(/```[\s\S]*?```/g, " ")
          .replace(/`([^`]*)`/g, "$1")
          .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
          .replace(/^\s*(#{1,6}|[-*+>]|\d+[.)])\s+/, "")
          .replace(/[*_~]+/g, "")
          .replace(/(^|\s)@\S+/g, " ")
          .replace(/\s+/g, " ")
          .trim(),
      )
      .find((l) => l.length > 0) || "";
  return line ? cut(line, 40) : untitledTitle(lang);
}

/** Clean a model-suggested title: one line, no quotes or trailing marks. */
export function sanitizeTitle(raw: string) {
  const line =
    raw
      .replace(/\r/g, "")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) || "";
  let clean = line
    .replace(/^(标题|群名|名称|title|name|好|good)\s*[:：]\s*/i, "")
    // A model that mimicked the prompt's 「好：… / 差：…」 (Good: … / Bad: …) examples.
    .replace(/\s*\/\s*(差|bad)\s*[:：].*$/i, "")
    .replace(/^[#*\-\s>]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  // Quotes and end marks in any order (「…」。 / "…".): strip until stable.
  for (let prev = ""; prev !== clean;) {
    prev = clean;
    clean = clean
      .replace(/^["'“”‘’「」『』《》【】]+|["'“”‘’「」『』《》【】]+$/g, "")
      .replace(/[。.!！?？,，;；:：]+$/g, "")
      .trim();
  }
  return clean ? cut(clean, 60) : "";
}

/** Completed rounds before a conversation gets its (single) AI title. */
export const SESSION_TITLE_AFTER = 2;
/** Attempts at most: after round 2, and once more after round 3. */
export const SESSION_TITLE_TRIES = 2;
/**
 * One attempt on the Runner — the native namer and,
 * when it cannot, the CLI call — ends within this; the control plane treats
 * an attempt as still running for a little longer (`TITLE_PENDING_MS`), so
 * it never asks again while the Runner is still on it.
 */
export const SESSION_TITLE_BUDGET_MS = 50_000;
/** The native namer's share of the budget (measured ~2 s). */
export const NATIVE_TITLE_MS = 15_000;
/**
 * Runner protocol for session titles (`capabilities.sessionTitles.version`):
 * the control plane only asks Runners that report it, so a Runner still on
 * older code never uses up an attempt it cannot make.
 */
export const SESSION_TITLE_PROTOCOL = 2;
/** One round of the conversation as the title prompt sees it. */
export interface TitleRound {
  user: string;
  reply: string;
}

/** Long fenced code blocks say little about the topic: keep a marker. */
function squeeze(text: string, lang: Lang) {
  return text
    .replace(/\r/g, "")
    .replace(
      /```([^\n`]*)\n([\s\S]*?)```/g,
      (block, code: string, body: string) =>
        body.length > 240
          ? promptT(lang)("prompt-title.code", { lang: code.trim() ? " " + code.trim() : "" })
          : block,
    )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}
/** Head and tail of a long text: the ask and the conclusion both survive. */
function clipMiddle(text: string, max: number) {
  const chars = [...text];
  if (chars.length <= max) return text;
  const head = Math.round(max * 0.7);
  return (
    chars.slice(0, head).join("").trimEnd() +
    " …… " +
    chars
      .slice(chars.length - (max - head))
      .join("")
      .trimStart()
  );
}

/**
 * Prompt for the one title of a conversation, from its first two rounds
 * (each user message and AI reply, cut sensibly). Built by the control plane
 * so a better prompt ships without restarting any Runner.
 */
export function sessionTitlePrompt(rounds: TitleRound[], lang: Lang = LEGACY_PROMPT_LANG) {
  // The title follows the person's language; told outright, since a Chinese
  // prompt otherwise pulls English conversations into Chinese titles.
  const asks = rounds
    .slice(0, SESSION_TITLE_AFTER)
    .map((r) => r.user)
    .join(" ");
  const cjk = (asks.match(/[\u3400-\u9fff]/g) || []).length,
    latin = (asks.match(/[A-Za-z]/g) || []).length;
  // English: Chinese characters fewer than a tenth of the Latin letters.
  const english = latin >= 12 && cjk * 10 < latin;
  const t = promptT(lang);
  return t.long("title-session", {
    languageRule: t(english ? "prompt-title.rule.english" : "prompt-title.rule.chinese"),
    conversation: sessionTitleDescription(rounds, lang),
  });
}

/**
 * the same first two rounds as material for the agent's own
 * namer (Claude Code `generate_session_title {description}`): it brings its
 * own instructions (language of the session, specific topic, JSON answer)
 * and treats this text as data inside `<session>`, so only the rounds go,
 * cut as for Daisy's prompt.
 */
export function sessionTitleDescription(rounds: TitleRound[], lang: Lang = LEGACY_PROMPT_LANG) {
  const t = promptT(lang);
  return rounds
    .slice(0, SESSION_TITLE_AFTER)
    .flatMap((r, i) => [
      `<round n="${i + 1}">`,
      "<user>",
      clipMiddle(squeeze(r.user, lang), 800) || t("prompt-title.noText"),
      "</user>",
      "<assistant>",
      clipMiddle(squeeze(r.reply, lang), 600) || t("prompt-title.noReply"),
      "</assistant>",
      "</round>",
    ])
    .join("\n");
}
/**
 * a name the owner gave the native session (Claude Code
 * `session_title_changed`, Codex `thread.name`): kept as written — one
 * line, control characters as spaces, at most 200 characters (the session
 * PATCH limit). Not `sanitizeTitle`: that cleans a model's answer.
 */
export function nativeTitle(raw: unknown) {
  if (typeof raw !== "string") return "";
  const one = raw
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return [...one].slice(0, 200).join("").trim();
}

/**
 * The custom title Daisy gives a Claude Code copy
 * (`forkSession`, /fork and an offline 「回退」) when Daisy's own title is
 * still the placeholder — the SDK always writes one. Never the owner's
 * name: a native session reporting it is not renamed, and its namer must
 * not answer it as the AI title.
 */
export const DAISY_FORK_TITLES = ["Daisy fork", "Daisy rewind"] as const;
/**
 * ADR-154: the markers written before (a copy made then still carries
 * one): recognised as markers too.
 */
export const LEGACY_FORK_TITLES = ["Harbor fork", "Harbor rewind"] as const;
export const isDaisyForkTitle = (t: unknown) =>
  [...DAISY_FORK_TITLES, ...LEGACY_FORK_TITLES].includes(nativeTitle(t) as never);
/**
 * the name a Claude copy of `session` gets: Daisy's AI / owner's
 * title (so it matches and needs no sync), else the marker.
 */
export function forkTitle(
  session: { title?: string; titleStage?: string },
  rewind: boolean,
) {
  const own =
    session.titleStage === "final" || session.titleStage === "manual"
      ? nativeTitle(session.title)
      : "";
  return own || DAISY_FORK_TITLES[rewind ? 1 : 0];
}
