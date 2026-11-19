/**
 * 「只问」 sidecars — storage, limits, the summaries that ride the
 * main session's next turn, and idle cleanup. P1-01: the routing (an
 * askOnly delivery became a sidecar job) and the answer post were chat
 * code in collaboration.ts and are gone with it (an excerpt is kept in
 * on tag baseline/pre-daisy); stage 4 routes 「问」 from
 * the A2A entry instead, one sidecar per visiting conversation.
 *
 * A sidecar is a hidden Daisy session (`Session.sidecar`) of the same
 * owner, identity, node and workspace as its main session: the Runner runs
 * it like any session, forking the main session's native context on its
 * first turn (Claude Code `--resume <main> --fork-session`, Codex
 * `thread/fork`) and enforcing read-only settings (turns/sidecar.ts).
 * One open sidecar per main session × `root` (the conversation it answers in).
 */
import { daisyEnv } from "../../../contracts/src/env.ts";
import type { Session } from "../../../contracts/src/index.ts";
import {
  ASK_SIDECAR,
  ASK_SIDECAR_AGENTS,
  askHistoryAdd,
  type AskFallback,
  type AskHistoryEntry,
  type AskVia,
} from "../../../contracts/src/ask-sidecar.ts";
import { Store, id } from "../store/index.ts";
import { clean } from "../prompts/source-prompt.ts";
import { sessionT } from "../../../contracts/src/prompt-i18n.ts";
import "../prompts/lang.ts";
import { log } from "../observe/log.ts";
import { inSessionT } from "../platform/language.ts";

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

export interface SidecarLimits {
  concurrent: number;
  daily: number;
  idleMs: number;
}

export function askSidecars(
  store: Store,
  o: { limits?: Partial<SidecarLimits> } = {},
) {
  const limits: SidecarLimits = {
    concurrent: num(
      daisyEnv("DAISY_ASK_SIDECAR_CONCURRENT"),
      ASK_SIDECAR.concurrent,
    ),
    daily: num(daisyEnv("DAISY_ASK_SIDECAR_DAILY"), ASK_SIDECAR.daily),
    idleMs: num(daisyEnv("DAISY_ASK_SIDECAR_IDLE_MS"), ASK_SIDECAR.idleMs),
    ...Object.fromEntries(
      Object.entries(o.limits || {}).filter(
        ([, v]) => typeof v === "number" && v > 0,
      ),
    ),
  };
  /** Why an askOnly @ to `main` wakes it normally instead (null: a sidecar answers). */
  const fallback = (main: Session): AskFallback | null => {
    if (main.settings?.askSidecar === false) return "disabled";
    if (!(ASK_SIDECAR_AGENTS as readonly string[]).includes(main.agent))
      return "unsupported";
    // An older Runner would run a sidecar as an ordinary (writable) session.
    try {
      const caps = JSON.parse(
        store.one("SELECT capabilities FROM nodes WHERE id=?", main.nodeId)
          ?.capabilities || "{}",
      );
      if (!(caps?.askSidecar?.version >= 1)) return "runner";
    } catch {
      return "runner";
    }
    return null;
  };
  const isSidecar = (sid: string) =>
    !!store.one("SELECT 1 FROM ask_sidecars WHERE id=?", sid);
  /** Sidecars of `parent` with a turn queued or running now (pending ones wait behind them). */
  const active = (parent: string) =>
    Number(
      store.one(
        `SELECT count(DISTINCT j.session_id) n FROM jobs j JOIN ask_sidecars a ON a.id=j.session_id
        WHERE a.parent=? AND j.status IN ('queued','running')`,
        parent,
      ).n,
    );
  /** Sidecar jobs of `parent` in the last 24 hours. */
  const today = (parent: string) =>
    Number(
      store.one(
        `SELECT count(*) n FROM jobs j JOIN ask_sidecars a ON a.id=j.session_id
        WHERE a.parent=? AND j.created>?`,
        parent,
        Date.now() - 86400_000,
      ).n,
    );
  /** The open sidecar of `main` for conversation `root`, if any. */
  const open = (parent: string, root: string): Session | null => {
    const r = store.one(
      "SELECT id FROM ask_sidecars WHERE parent=? AND root=? AND closed IS NULL ORDER BY created DESC LIMIT 1",
      parent,
      root,
    );
    const s = r && store.session(r.id);
    return s && !s.deleting && !s.archived ? s : null;
  };
  /**
   * The sidecar answering conversation `root` (in `tid`) for `main`: the open one
   * (a follow-up resumes it), else a new hidden session that forks the
   * main session's native context on its first turn.
   */
  const sidecarFor = (main: Session, tid: string, root: string) => {
    const prior = open(main.id, root);
    if (prior) {
      store.run(
        "UPDATE ask_sidecars SET last_used=? WHERE id=?",
        Date.now(),
        prior.id,
      );
      return { session: prior, created: false };
    }
    const now = Date.now();
    const s: Session = {
      id: id(),
      ownerId: main.ownerId,
      title: sessionT(main)("prompt-ask.sidecarTitle", { title: main.title }).slice(0, 200),
      agent: main.agent,
      nodeId: main.nodeId,
      workspaceId: main.workspaceId,
      profileId: main.profileId,
      ...(main.workspaceMode ? { workspaceMode: main.workspaceMode } : {}),
      nativeId: null,
      // A fork already carries the main session's first-turn context.
      ...(main.nativeId ? { contextDelivered: true } : {}),
      // Not bound to the main session's task (no task lists, no 快速了解).
      task: null,
      // P6-24: it reads the main conversation: the same language.
      ...(main.lang ? { lang: main.lang } : {}),
      status: "idle",
      archived: false,
      ...(main.settings
        ? {
            settings: Object.fromEntries(
              Object.entries(main.settings).filter(([k]) => k !== "askSidecar"),
            ),
          }
        : {}),
      sidecar: {
        parent: main.id,
        threadId: tid,
        root,
        forkFrom: main.nativeId || null,
        createdAt: now,
      },
      createdAt: now,
      updatedAt: now,
    } as Session;
    store.save(s);
    store.run(
      "INSERT INTO ask_sidecars(id,parent,thread_id,root,created,last_used,closed) VALUES(?,?,?,?,?,?,NULL)",
      s.id,
      main.id,
      tid,
      root,
      now,
      now,
    );
    return { session: s, created: true };
  };
  /** Keep a summary for `main`'s next turn. */
  const keep = (o: {
    main: string;
    sidecar: string;
    tid: string;
    mid: string;
    text: string;
  }) =>
    store.run(
      "INSERT INTO sidecar_summaries(id,session_id,sidecar_id,thread_id,message_id,text,created) VALUES(?,?,?,?,?,?,?)",
      id(),
      o.main,
      o.sidecar,
      o.tid,
      o.mid,
      o.text,
      Date.now(),
    );
  /** Summaries waiting for `sid` (oldest first). */
  const waiting = (sid: string) =>
    store.all(
      "SELECT * FROM sidecar_summaries WHERE session_id=? AND carried_job IS NULL ORDER BY created,id",
      sid,
    );
  /**
   * The summaries a main-session turn being claimed takes along (the
   * kept reports' carry point): merged into one block in its preamble, deleted
   * in the same step (once only; a re-claim resends the same preamble).
   * They are marked with the job, deleted when it ends well (`settled`),
   * given back when it fails or is stopped (at least once, never lost).
   * Each one is quoted as external data: the question and the answer are
   * other people's and the sidecar's words, not the owner's instructions.
   * Not into: a sidecar's own turn, operations, `/` commands, a turn the
   * Agent started by itself (it has no prompt), or an understanding turn.
   */
  const carry = (job: any) =>
    store.atomic(() => {
      if (!job?.id || !job.session_id || isSidecar(job.session_id)) return job;
      if (
        String(job.text || "")
          .trimStart()
          .startsWith("/")
      )
        return job;
      if (store.one("SELECT 1 FROM job_operations WHERE job_id=?", job.id))
        return job;
      const rid = String(job.request_id || "");
      if (job.origin === "agent" || rid.startsWith("understanding:"))
        return job;
      const now = Date.now();
      store.run(
        "DELETE FROM sidecar_summaries WHERE session_id=? AND created<?",
        job.session_id,
        now - ASK_SIDECAR.keepMs,
      );
      const rows = waiting(job.session_id);
      if (!rows.length) return job;
      const taken: any[] = [];
      let size = 0;
      for (const r of rows) {
        if (taken.length && size + r.text.length > ASK_SIDECAR.carryCap) break;
        taken.push(r);
        size += r.text.length;
      }
      const left = rows.length - taken.length;
      // P6-24: in the main session's language.
      const t = sessionT(store.session(job.session_id));
      const block =
        t("prompt-ask.carry.head", { count: taken.length }) +
        (left ? t("prompt-ask.carry.left", { count: left }) : "") +
        "\n" +
        taken
          .map(
            (r, i) =>
              `${t("prompt-ask.carry.item", { n: i + 1 })}\n<external_message>\n${clean(r.text)}\n</external_message>`,
          )
          .join("\n");
      for (const r of taken)
        store.run(
          "UPDATE sidecar_summaries SET carried_job=? WHERE id=?",
          job.id,
          r.id,
        );
      const preamble = job.preamble ? `${job.preamble}\n\n${block}` : block;
      store.run("UPDATE jobs SET preamble=? WHERE id=?", preamble, job.id);
      log.info(
        `[ask-sidecar] session=${job.session_id} job=${job.id} carried ${taken.length} summary(ies)${left ? `, ${left} left` : ""}`,
      );
      return { ...job, preamble };
    });
  /**
   * Close sidecars unused for `idleMs` with nothing queued (archived, kept
   * for the record; the next ask there forks a new one). Returns
   * the ids closed. Also closes those whose main session is gone.
   */
  const sweep = (now = Date.now()) => {
    const closed: string[] = [];
    for (const r of store.all(
      `SELECT a.* FROM ask_sidecars a WHERE a.closed IS NULL AND (a.last_used<? OR NOT EXISTS(
        SELECT 1 FROM sessions s WHERE s.id=a.parent AND COALESCE(json_extract(s.data,'$.deleting'),0)=0))
        AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.session_id=a.id AND j.status IN ('pending','queued','running'))
        LIMIT 50`,
      now - limits.idleMs,
    )) {
      store.atomic(() => {
        store.run("UPDATE ask_sidecars SET closed=? WHERE id=?", now, r.id);
        const s = store.session(r.id);
        if (s && !s.archived) {
          s.archived = true;
          s.updatedAt = now;
          store.save(s);
        }
      });
      closed.push(r.id);
    }
    return closed;
  };
  /**
   * A main-session job ended: the summaries it carried are done (it ended
   * well) or waiting again (failed / stopped / lost).
   */
  const settled = (jobId: string, ok: boolean) =>
    store.run(
      ok
        ? "DELETE FROM sidecar_summaries WHERE carried_job=?"
        : "UPDATE sidecar_summaries SET carried_job=NULL WHERE carried_job=?",
      jobId,
    );
  /** the earlier questions / answers of sidecar `sid`. */
  const history = (sid: string): AskHistoryEntry[] => {
    try {
      const h = JSON.parse(
        store.one("SELECT history FROM ask_sidecars WHERE id=?", sid)
          ?.history || "[]",
      );
      return Array.isArray(h) ? h : [];
    } catch {
      return [];
    }
  };
  /** one more answered question of sidecar `sid`. */
  const remember = (
    sid: string,
    e: { question: string; response: string; via: AskVia },
  ) =>
    store.run(
      "UPDATE ask_sidecars SET history=? WHERE id=?",
      JSON.stringify(askHistoryAdd(history(sid), { ...e, at: Date.now() })),
      sid,
    );
  /** Close every open sidecar of `parent` (its owner turned them off, or it was archived). */
  const closeAll = (parent: string) => {
    const now = Date.now();
    for (const r of store.all(
      "SELECT id FROM ask_sidecars WHERE parent=? AND closed IS NULL",
      parent,
    )) {
      store.run("UPDATE ask_sidecars SET closed=? WHERE id=?", now, r.id);
      const s = store.session(r.id);
      if (s && !s.archived) {
        s.archived = true;
        s.updatedAt = now;
        store.save(s);
      }
    }
  };
  return {
    limits,
    fallback,
    isSidecar,
    active,
    today,
    open,
    sidecarFor,
    keep,
    waiting,
    carry,
    settled,
    sweep,
    closeAll,
    history,
    remember,
  };
}
export type AskSidecars = ReturnType<typeof askSidecars>;
