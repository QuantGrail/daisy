import { isAcpAgent } from "../../../contracts/src/acp-harnesses.ts";
import {
  fallbackTitle,
  sessionTitlePrompt,
  sessionTitleDescription,
  SESSION_TITLE_BUDGET_MS,
  SESSION_TITLE_AFTER,
  SESSION_TITLE_PROTOCOL,
  SESSION_TITLE_TRIES,
  sessionLang,
} from "../../../contracts/src/index.ts";
import { titleRoute } from "../../../contracts/src/agent-capabilities.ts";
// P6-24: the packs for the prompts built here (side effect).
import "../prompts/lang.ts";
import type { AppBase } from "./context.ts";
/** Conversation titles (P1-00: moved from app.ts). */
export function titleHelpers(ctx: AppBase) {
  const { store } = ctx;
  /**
   * While a conversation is untitled, its first message names it at
   * once with its first sentence (a placeholder, not AI; the AI title comes
   * after the second round). Call inside the transaction that inserted the
   * job.
   */
  function provisionalTitle(sid: string, text: string) {
    const s = store.session(sid);
    if (
      !s?.titleAuto ||
      store.one("SELECT COUNT(*) n FROM jobs WHERE session_id=?", sid).n > 1
    )
      return;
    s.title = fallbackTitle(text, sessionLang(s));
    store.save(s);
  }
  /** An attempt younger than this is still running on the Runner (its whole budget). */
  const TITLE_PENDING_MS = SESSION_TITLE_BUDGET_MS + 10_000;
  /**
   * Does this node's Runner make `agent`'s session titles the current way?
   * by its reported `title.generate` (none: never named — Kimi);
   * a Runner without it: every agent but Kimi, as before.
   */
  function nodeNamesSessions(nodeId: string, agent: string) {
    try {
      const caps = JSON.parse(
        store.one("SELECT capabilities FROM nodes WHERE id=?", nodeId)
          ?.capabilities || "{}",
      );
      if (!(caps.sessionTitles?.version >= SESSION_TITLE_PROTOCOL))
        return false;
      const route = titleRoute(caps, agent);
      return route ? route.generate !== "none" : !isAcpAgent(agent);
    } catch {
      return false;
    }
  }
  /** What the person asked in a round (a chat delivery wraps the question). */
  function roundAsk(text: string) {
    const wrapped = /<external_message>\n([\s\S]*?)\n<\/external_message>/.exec(
      text,
    );
    if (wrapped)
      try {
        return String(JSON.parse(wrapped[1]).text || "");
      } catch {
        /* keep the raw text */
      }
    return text;
  }
  /**
   * The first rounds of a conversation, oldest first: the person's own
   * completed turns (not Agent-started turns, operations or task briefs),
   * each with the AI's reply of that turn.
   */
  function titleRounds(sid: string) {
    const jobs = store.all(
      `SELECT id,text FROM jobs WHERE session_id=? AND status='completed'
         AND COALESCE(origin,'')!='agent' AND request_id NOT LIKE 'understanding:%'
         AND id NOT IN (SELECT job_id FROM job_operations)
       ORDER BY created LIMIT ?`,
      sid,
      SESSION_TITLE_AFTER,
    );
    return jobs.map((j: any) => ({
      // Full texts: the prompt keeps the head and tail of each.
      user: roundAsk(String(j.text || "")),
      reply: store
        .all(
          "SELECT data FROM items WHERE session_id=? AND id LIKE ? ESCAPE '\\'",
          sid,
          j.id.replace(/[\\%_]/g, "\\$&") + ":%",
        )
        .map((r: any) => JSON.parse(r.data))
        .filter((i: any) => i.kind === "assistant" && i.text && !i.retracted)
        .sort((a: any, b: any) => (a.createdAt || 0) - (b.createdAt || 0))
        .map((i: any) => String(i.text))
        .join("\n"),
    }));
  }
  /**
   * After a successful round of an untitled conversation:
   * from the second completed round on, ask the Runner for the one AI title
   * of the first two rounds; a failed attempt is retried once at the next
   * round, then the placeholder stays. Attempts are stored on the session,
   * so a Runner restart or a replayed completion never asks again; a Runner
   * still on older code is not asked (and no attempt is used up) until it
   * runs the current release. `resend`: the same job's completion arrived
   * again (lost response) — repeat its request without a new attempt.
   */
  function titleRequest(jobId: string, sid: string, resend = false) {
    return store.atomic(() => {
      const s = store.session(sid);
      if (
        !s?.titleAuto ||
        s.titleStage ||
        !nodeNamesSessions(s.nodeId, s.agent)
      )
        return null;
      const pending =
        !!s.titleAskedAt && Date.now() - s.titleAskedAt < TITLE_PENDING_MS;
      if (resend ? !(pending && s.titleJob === jobId) : pending) return null;
      if (!resend && (s.titleTries || 0) >= SESSION_TITLE_TRIES) return null;
      const rounds = titleRounds(sid);
      if (rounds.length < SESSION_TITLE_AFTER) return null;
      if (!resend) {
        s.titleTries = (s.titleTries || 0) + 1;
        s.titleAskedAt = Date.now();
        s.titleJob = jobId;
        store.save(s);
      }
      return {
        stage: "final" as const,
        attempt: s.titleTries,
        prompt: sessionTitlePrompt(rounds, sessionLang(s)),
        // the rounds alone, for an agent that names it natively
        // (an older Runner ignores it and uses the prompt).
        description: sessionTitleDescription(rounds, sessionLang(s)),
      };
    });
  }
  return { provisionalTitle, titleRequest };
}
export type TitleHelpers = ReturnType<typeof titleHelpers>;
