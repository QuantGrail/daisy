/**
 * P4-05 (总纲 5.7, ADR-124): what the AI is told for a 「问」 or a 「办」
 * that came in over A2A. Everything the caller wrote — this message, the
 * earlier requests and answers of the conversation, the referenced tasks,
 * this task's own exchange — is quoted as external material
 * (`<external_message>`, `<` / `>` escaped as everywhere else Daisy quotes
 * other people's text), never as the owner's instructions.
 *
 * P4-06 (ADR-125): `source()` is the full source marking of D-18 — who,
 * how Daisy knows them, through which AI, which agent, with what grant,
 * the task and the trace.
 */
import { askSeparator, askSeparators, lastMarker } from "../../../contracts/src/ask-sidecar.ts";
import type { Lang } from "../../../contracts/src/i18n.ts";
import { LEGACY_PROMPT_LANG, promptForms, promptT, type PromptT } from "../../../contracts/src/prompt-i18n.ts";
import "../prompts/lang.ts";
import { clean, line } from "../prompts/source-prompt.ts";
import type { A2AJob, A2APriorTask } from "./executors.ts";

/**
 * The line after which the AI asks the caller for more (→
 * TASK_STATE_INPUT_REQUIRED), in the session's language (P6-24: was the
 * constant `NEEDS_INPUT`, 「===需要对方补充===」 — still the Chinese form).
 */
export const needsInput = (lang: Lang = LEGACY_PROMPT_LANG) => promptT(lang)("prompt-a2a.needsInput");
/** Every language's form: what `readAnswer` looks for. */
export const needsInputs = () => promptForms("prompt-a2a.needsInput");
/** At most this much of the conversation's earlier requests goes into one prompt. */
const HISTORY_CAP = 12_000;

export type TurnKind = "branch" | "main-ask" | "act";

const quote = (t: string) => `<external_message>\n${clean(String(t ?? ""))}\n</external_message>`;
const cut = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1) + "…" : t);

/** How the call authorization let the call in (D-18: what grant it came with): its key. */
const VIA_KEY: Record<string, string> = {
  whitelist: "prompt-a2a.via.whitelist",
  listed: "prompt-a2a.via.listed",
  grant: "prompt-a2a.via.grant",
  once: "prompt-a2a.via.once",
};

/**
 * Who is asking, one line (D-18, P4-06): the person and how Daisy knows
 * them, through which of their AIs, which of the owner's agents they
 * called, how they were let in, the task and its place on the trace.
 * Every part someone else chose is flattened (`line`): it cannot open a
 * new section. In the session's language (`lang`).
 */
export function source(job: A2AJob, lang: Lang = LEGACY_PROMPT_LANG): string {
  const t = promptT(lang);
  return t("prompt-a2a.source", {
    who: line(job.caller.name, 60) || t("prompt-a2a.caller.fallback"),
    known: t(job.caller.contactId ? "prompt-a2a.caller.contact" : "prompt-a2a.caller.issuer"),
    via: job.caller.actor ? t("prompt-a2a.caller.actor", { actor: line(job.caller.actor, 60) }) : t("prompt-a2a.caller.noActor"),
    kind: t(job.agent.kind === "resident" ? "prompt-a2a.agent.resident" : "prompt-a2a.agent.public"),
    agent: t("prompt-a2a.agent.name", { name: line(job.agent.name, 60) || job.agent.id }),
    grant: job.via && VIA_KEY[job.via] ? t.dynamic(VIA_KEY[job.via]!) : t("prompt-a2a.via.none"),
    task: job.taskId,
    trace: job.trace.traceId,
    depth: job.trace.depth,
  });
}

/** One earlier task of the conversation, quoted. */
export const priorTask = (t: PromptT, p: A2APriorTask) =>
  `${t("prompt-a2a.prior.item", { task: p.taskId })}\n${quote(
    t("prompt-a2a.prior.qa", { question: cut(p.request, 4000), answer: cut(p.answer ?? t("prompt-a2a.prior.noAnswer"), 6000) }),
  )}`;
/** The heading over `count` earlier tasks. */
export const priorsHead = (t: PromptT, title: string, count: number) => t("prompt-a2a.prior.head", { title, count });
/** This task's exchange so far (without its last message), quoted. */
export const exchange = (t: PromptT, job: A2AJob) =>
  job.thread
    .slice(0, -1)
    .map((m) =>
      t("prompt-a2a.thread.line", {
        who: t(m.role === "agent" ? "prompt-a2a.thread.you" : "prompt-a2a.thread.them"),
        text: quote(cut(m.text, 6000)),
      }),
    )
    .join("\n");
/** `NEEDS_INPUT`'s instruction: how to ask the caller for more. */
export const askLine = (t: PromptT) => t("prompt-a2a.ask", { needsInput: t("prompt-a2a.needsInput") });
export { quote as quoteExternal };

function priors(t: PromptT, title: string, list: A2APriorTask[]): string {
  if (!list.length) return "";
  let size = 0;
  const shown: string[] = [];
  // Newest last; drop the oldest past the cap.
  for (const p of [...list].reverse()) {
    const one = priorTask(t, p);
    if (shown.length && size + one.length > HISTORY_CAP) break;
    shown.unshift(one);
    size += one.length;
  }
  return `${priorsHead(t, title, shown.length)}\n${shown.join("\n")}\n\n`;
}

/**
 * The prompt of one turn. `kind`: a read-only branch (answer + a one-line
 * summary for the main line), the main line read-only (问 fell back), or
 * the main line acting (办). `lang`: the language of the session it runs in.
 */
export function askActPrompt(job: A2AJob, kind: TurnKind, o: { readOnly?: "strong" | "weak"; lang?: Lang } = {}): string {
  const lang = o.lang ?? LEGACY_PROMPT_LANG;
  const t = promptT(lang);
  const src = source(job, lang);
  const head = t(kind === "act" ? "prompt-a2a.head.act" : kind === "branch" ? "prompt-a2a.head.branch" : "prompt-a2a.head.mainAsk", {
    source: src,
  });
  const rules =
    kind === "act"
      ? t("prompt-a2a.rules.act")
      : t("prompt-a2a.rules.readOnly") + (o.readOnly === "weak" ? t("prompt-a2a.rules.weak") : "") + t("prompt-a2a.rules.readOnlyTail");
  const answer =
    kind === "branch"
      ? t("prompt-a2a.answer.branch", { separator: askSeparator(lang) })
      : t("prompt-a2a.answer.plain");
  const parts = [
    head,
    rules,
    `${answer}${askLine(t)}`,
    "",
    priors(t, t("prompt-a2a.prior.history"), job.history),
    priors(t, t("prompt-a2a.prior.references"), job.references),
  ];
  if (job.continuing) {
    parts.push(`${t("prompt-a2a.thread.head")}\n${exchange(t, job)}\n`, `${t("prompt-a2a.followUp")}\n${quote(job.text)}`);
  } else parts.push(`${t("prompt-a2a.request")}\n${quote(job.text)}`);
  if (job.files.length) parts.push(t("prompt-a2a.files", { count: job.files.length }));
  return parts.filter((x) => x !== "").join("\n");
}

/**
 * Split the AI's last words: the answer, the one-line summary for the main
 * line (after the separator, a branch only), or a question for the
 * caller (after the needs-input line). Either marker is recognised in
 * every language.
 */
export function readAnswer(raw: string): { answer: string; summary: string | null; question: string | null } {
  const text = String(raw ?? "").trim();
  const ni = lastMarker(text, needsInputs());
  if (ni.at >= 0) {
    const question = text.slice(ni.at + ni.marker.length).trim();
    if (question) return { answer: "", summary: null, question };
  }
  const { at, marker } = lastMarker(text, askSeparators());
  if (at < 0) return { answer: text, summary: null, question: null };
  const answer = text.slice(0, at).trim();
  const summary = text
    .slice(at + marker.length)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ");
  return { answer: answer || text, summary: summary || null, question: null };
}

/** The one sentence the main line gets for a 问 answered on a branch (5.7), in the main session's language. */
export function oneLineSummary(job: A2AJob, answer: string, summary: string | null, lang: Lang = LEGACY_PROMPT_LANG): string {
  const t = promptT(lang);
  const who = line(job.caller.name, 40) || t("prompt-a2a.caller.fallback");
  const body = summary
    ? line(summary, 200)
    : t("prompt-a2a.summary.excerpt", { question: line(job.text, 80), answer: line(answer, 120) });
  return t("prompt-a2a.summary", { who, task: job.taskId, body });
}
