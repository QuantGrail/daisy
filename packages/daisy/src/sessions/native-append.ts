import { sessionFeatures } from "./features.ts";
import { harnessName } from "../../../contracts/src/agent-features.ts";
/**
 * Native append (「要停就按停止，插入消息时不该打断」): a Daisy job delivered into the running turn through the agent's
 * own input queue — Claude Code `priority:"next"` (read at the next tool
 * boundary, same turn, subagents untouched), Codex `turn/steer` — instead
 * of stopping that turn. 「插队发送」 while a turn runs, and Daisy wakes
 * (plugin callbacks, timers, approval decisions, background reports,
 * classifier retries) arriving while one runs, go this way when the
 * agent's adapter says it can (`capabilities.agentFeatures`, contracts
 * agent-capabilities.ts); everything else goes to the head of Daisy's queue.
 *
 * Daisy's queue stays the source of truth: the job keeps its row
 * (`status='appended'`) and a `live_inputs` row (`source_job`) carries it
 * to the Runner. It is done when the agent reports `completed`; given back
 * (cancelled, the turn ended without reading it, the process or lease was
 * lost) it is `pending` again at the head of the queue — the same job, its
 * request id, origin, attachments and budget class unchanged.
 *
 * Table native_appends, column live_inputs.source_job (store/schema.ts;
 * older releases see an `appended` job as neither pending nor running).
 */
import { readFileSync } from "node:fs";
import { id, type Store } from "../store/index.ts";
import { callbackJob } from "../schedule/callback-jobs.ts";
import { ownerT, inSessionT } from "../platform/language.ts";
import type { MessageKey, Translate } from "../../../contracts/src/i18n.ts";
import { forgetJump, jumpedList, othersJob, recordJump } from "./queue-jump.ts";
import {
  carryBlock,
  mergeKind,
  removedWithParts,
  restoreCarried,
} from "./queue-merge.ts";
import {
  NATIVE_INPUT_SINCE,
  inputRoute,
  isFallback,
  type InputRoute,
} from "../../../contracts/src/agent-capabilities.ts";
import type { Session } from "../../../contracts/src/index.ts";
import {
  localTimeZone,
  zoned,
  zoneName,
} from "../../../contracts/src/scheduler.ts";

type Publish = (sid: string, type: any, data: any) => any;

export function purgeAppends(store: Store, sid: string) {
  store.run("DELETE FROM native_appends WHERE session_id=?", sid);
}

/** What the session's agent can do on its node (null: older Runner). */
export function inputCaps(store: Store, s: Session): InputRoute | null {
  try {
    return inputRoute(
      JSON.parse(
        store.one("SELECT capabilities FROM nodes WHERE id=?", s.nodeId)
          ?.capabilities || "{}",
      ),
      s.agent,
    );
  } catch {
    return null;
  }
}
/**
 * Hotfix 3: the agent has no native input queue but Daisy's own 立即追加
 * works for it — the adapter reports `steer` as
 * `fallback` (Claude / Codex below the measured CLI version; `harbor` from
 * a Runner before ADR-152). Not Kimi (no
 * way into a running turn at all), not an adapter reporting `none`.
 */
export function daisySteer(store: Store, s: Session): boolean {
  // P4-11: was `agent === "kimi"` — no 运行中追加 declared at all.
  if (sessionFeatures(store, s).steer === "none") return false;
  try {
    const c = JSON.parse(
      store.one("SELECT capabilities FROM nodes WHERE id=?", s.nodeId)
        ?.capabilities || "{}",
    )?.agentFeatures?.[s.agent];
    return isFallback(c?.input?.steer?.support);
  } catch {
    return false;
  }
}
/** The session's turn a job can be appended into (running, not stopping). */
export function liveTurn(store: Store, sid: string): any | null {
  return (
    store.one(
      "SELECT j.* FROM jobs j LEFT JOIN job_operations o ON o.job_id=j.id WHERE j.session_id=? AND j.status='running' AND j.cancel=0 AND o.job_id IS NULL",
      sid,
    ) ?? null
  );
}
const parse = (v: any) => {
  try {
    return v ? JSON.parse(v) : null;
  } catch {
    return null;
  }
};
const IMAGE = /^image\/(png|jpeg|gif|webp)$/;

/** Daisy wakes the owner's own turn may take in (the queue-merge carry set). */
const OWNER_TURN_TAKES = new Set([
  "owner",
  "schedule:callback",
  "schedule:callback-human",
  "collab:own",
  "schedule:own",
]);
/**
 * Review H1: whose turn is running decides what may join it — never only
 * the item. A group request (`chat:`), 「快速了解」, a native operation, or
 * an older event wake marked on its item: nothing joins
 * (someone else's request; its asker, delivery and permissions are its
 * own). Her typed words join any other turn of her session (hotfix:
 * a resident's turns are mostly wakes) — under that turn's
 * permissions. A Daisy wake's turn: otherwise only a wake of the same
 * class (same `mergeKind` = same origin, owner authority and budget rule —
 * the queue-merge same-kind merge) — except the owner's own wakes (hotfix 2:
 * callbacks, `schedule:own`, `collab:own`), which join any of them. The
 * owner's own turn:
 * her words and the Daisy wakes queue-merge lets her turn carry (plugin
 * callbacks, her approval decisions, her own timers) — permissions
 * (the bypass policy) are then the same as that carry's. Null: it fits.
 */
export function turnFit(store: Store, running: any, job: any): string | null {
  const t = ownerT();
  const rid = String(running.request_id || "");
  if (rid.startsWith("chat:")) return t("server-sessions.append.fit.othersRequest");
  if (rid.startsWith("understanding:")) return t("server-sessions.append.fit.understanding");
  if (rid.startsWith("op:")) return t("server-sessions.append.fit.nativeOperation");
  // An older event wake (origin only on its item): someone else's.
  if (!running.origin && !rid.startsWith("steer:") && othersJob(store, running))
    return t("server-sessions.append.fit.othersRequest");
  const k = mergeKind(store, job);
  // Hotfix (resident): her typed words may join any turn of her
  // own session that serves no one else — a Daisy wake's (timer, callback,
  // monitor, approval decision, classifier retry) or the AI's own. They run
  // with that turn's permissions (narrower when it has no owner bypass;
  // machine text is never widened).
  if (k === "owner") return null;
  // Hotfix 2 (callbacks about the owner's own items were taken for
  // someone else's; cron and background-command wakes the same): a Daisy wake of the owner's own session with her
  // authority — a plugin callback about her own ticket (the plugin
  // takes only entries the session owner authored), her own timer / cron /
  // wakeup / background or monitor report (`schedule:own`), her approval
  // decision (`collab:own`) — is her business, not someone else's. It
  // joins any turn of her session that serves no one else, as her typed
  // words do: her own, the AI's own, any other Daisy wake's. Read as
  // queue-merge carries it (a fenced 资料 block, appendPayload) unless the turn
  // is of its own class. Permissions: what queue-merge lets her turn carry
  // already; `schedule:own` / `collab:own` have the AI's own authority
  // (bypass-policy ownerTurn), callbacks only ride as fenced 资料. Wakes without
  // the owner's authority (`schedule:other`, `collab:other`) keep the
  // same-class rule. Budget as for kept callbacks and native appends.
  if (k && OWNER_TURN_TAKES.has(k)) return null;
  // Hotfix 3: the classifier retry is Daisy's notice
  // about this very session's own turn (its operations, its auto mode) —
  // it joins any turn of the session that serves no one else, not only
  // her own (re-review A). Never a carrier (`collab:other` stays its
  // class); fenced as 资料 unless the turn is one too. Permissions are not
  // widened: a classifier only runs in auto mode (no bypass), and the
  // retry already joins her own turn whatever its mode. Budget as
  // re-review A (an appended retry counts as a machine wake).
  if (String(job.request_id || "").startsWith("classifier-retry:")) return null;
  if (running.origin === "agent") return t("server-sessions.append.fit.agentTurn");
  if (running.origin === "schedule" || running.origin === "collab") {
    if (!k || k !== mergeKind(store, running))
      return t("server-sessions.append.fit.otherWake");
    return null;
  }
  if (!k || !OWNER_TURN_TAKES.has(k)) return t("server-sessions.append.fit.wakeNotYours");
  return null;
}

/**
 * Why pending `job` cannot go into `running` natively (null: it can) —
 * shown as the reason it runs right after this turn instead.
 */
export function appendBlocker(
  store: Store,
  s: Session,
  job: any,
  running: any,
): string | null {
  const t = ownerT();
  if (!running || running.status !== "running" || running.cancel)
    return t("server-sessions.append.block.noTurn");
  if (store.one("SELECT 1 FROM job_operations WHERE job_id=?", running.id))
    return t("server-sessions.append.fit.nativeOperation");
  if (s.sidecar) return t("server-sessions.append.block.sidecar");
  if (store.one("SELECT 1 FROM job_operations WHERE job_id=?", job.id))
    return t("server-sessions.append.block.ownOperation");
  const rid = String(job.request_id || "");
  if (rid.startsWith("chat:")) return t("server-sessions.append.block.chat");
  if (rid.startsWith("understanding:")) return t("server-sessions.append.block.understanding");
  if (rid.startsWith("op:")) return t("server-sessions.append.block.ownOperation");
  // a steer handed back may still be withdrawn by a late start.
  if (rid.startsWith("steer:")) return t("server-sessions.append.block.steer");
  if (job.origin === "agent") return t("server-sessions.append.block.agent");
  if (
    String(job.text || "")
      .trimStart()
      .startsWith("/")
  )
    return t("server-sessions.append.block.slash");
  const fit = turnFit(store, running, job);
  if (fit) return fit;
  const caps = inputCaps(store, s);
  if (!caps?.append)
    return sessionFeatures(store, s).steer === "none"
      ? t("server-sessions.append.block.harness", { harness: harnessName(s.agent, t) })
      : !caps
        ? t("server-sessions.append.block.runnerOld")
        : daisySteer(store, s)
          ? legacyWhy(s, job, detectedCli(store, s))
          : t("server-sessions.append.block.cliOld", { detected: detectedCli(store, s) });
  const files = (parse(job.attachments) || []) as string[];
  if (files.length) {
    const mimes = files.map(
      (aid) =>
        store.one("SELECT mime FROM attachments WHERE id=?", aid)?.mime || "",
    );
    // Other files reach the agent as paths in the text (as in a turn);
    // images go in as image content — only where the adapter can.
    if (mimes.some((m) => IMAGE.test(m)) && !caps.images)
      return t("server-sessions.append.block.image");
  }
  return null;
}

/**
 * Whether `why` (appendBlocker's answer) names only the node's / agent's
 * version — a Runner not updated, or a CLI that appends plain text only —
 * so the owner's plain text may still go in as Daisy's 立即追加. The reason
 * was just said in the owner's language; the Chinese forms stay recognised.
 */
export function versionOnlyBlock(why: string): boolean {
  const t = ownerT();
  return (
    why === t("server-sessions.append.block.runnerOld") ||
    why.startsWith(t("server-sessions.append.legacyText", { upgrade: "", detected: "" })) ||
    /^(执行节点的 Runner 还没更新|这个 AI 的 CLI 版本只能追加纯文字)/.test(why)
  );
}

/**
 * Hotfix 3 (review of fc0c835): a CLI below the measured version takes
 * only the owner's plain text, as Daisy's 立即追加 (commands.ts jump, as
 * hotfix 1). A Daisy wake is not sent that way: such a CLI cannot say
 * whether it read it (no read report; the hand-over ack and its 15 s
 * timeout are not reads, and a stop leaves it with the agent), so a
 * callback could run twice or be lost — it waits for this turn, saying so.
 */
/**
 * Follow-up 2026-11-09 (a reporter upgraded Claude Code and still saw the
 * old-CLI reason): which CLI version the node's Runner detected — the one
 * its features were computed from (`agentFeatures[agent].cliVersion`; an
 * older Runner: the node's `capabilities[agent].version`).
 */
export function detectedCli(store: Store, s: Session): string {
  const name = s.agent === "codex" ? "Codex" : "Claude Code";
  let raw: unknown;
  try {
    const c = JSON.parse(
      store.one("SELECT capabilities FROM nodes WHERE id=?", s.nodeId)
        ?.capabilities || "{}",
    );
    raw = c?.agentFeatures?.[s.agent]?.cliVersion ?? c?.[s.agent]?.version;
  } catch {}
  const v = /(\d+\.\d+\.\d+)/.exec(typeof raw === "string" ? raw : "")?.[1];
  return v
    ? ownerT()("server-sessions.append.detected", { name, version: v })
    : ownerT()("server-sessions.append.detectedNone", { name });
}
function legacyWhy(s: Session, job: any, detected: string): string {
  const t = ownerT();
  const since = NATIVE_INPUT_SINCE[s.agent];
  const upgrade = since
    ? t("server-sessions.append.upgrade", {
        name: s.agent === "codex" ? "Codex" : "Claude Code",
        version: since.join("."),
      })
    : "";
  return t(job.origin ? "server-sessions.append.legacyWake" : "server-sessions.append.legacyText", { upgrade, detected });
}
/**
 * A wake item's delivery tail (「（已追加…）」): the stored text ends with
 * it. New items name the tail they carry (`tail`), so it is cut off by
 * exactly that text in whatever language it was written; items from
 * before that carry the old Chinese tails, cut by their pattern.
 */
export function wakeBase(item: { text?: unknown; tail?: unknown }): string {
  const text = String(item.text || "");
  if (typeof item.tail === "string" && item.tail && text.endsWith(item.tail)) return text.slice(0, -item.tail.length);
  return text.replace(/（(已|不会|没)[^）]*）$/, "");
}
const userItem = (store: Store, sid: string, jid: string) =>
  parse(
    store.one(
      "SELECT data FROM items WHERE session_id=? AND id=?",
      sid,
      `user:${jid}`,
    )?.data,
  );
/** The job's own marks in the conversation: its bubble, or its wake marker. */
function mark(
  store: Store,
  sid: string,
  job: any,
  status: string,
  tailKey: MessageKey,
  publish: Publish,
  /** The running job it went into (null: back in Daisy's queue). */
  into?: string | null,
  /** Follow-up 2026-11-09: `read` — the agent has read it (「Agent 已读取」). */
  delivery?: "read",
) {
  // `appendedInto`: the conversation groups it with that turn,
  // as a 立即追加 — not as a turn of its own (present.ts groupTurns).
  const where = (d: any) => {
    const { appendedInto, ...rest } = d;
    void appendedInto;
    return into === undefined
      ? d
      : into
        ? { ...rest, appendedInto: into }
        : rest;
  };
  const item = userItem(store, sid, job.id);
  if (item)
    publish(
      sid,
      "item",
      where({
        ...item,
        id: `user:${job.id}`,
        kind: "user",
        status,
        ...(delivery ? { delivery } : {}),
      }),
    );
  const w = parse(
    store.one(
      "SELECT data FROM items WHERE session_id=? AND id=?",
      sid,
      `wake:${job.id}`,
    )?.data,
  );
  if (w) {
    const base = wakeBase(w);
    const tail = inSessionT(store.session(sid)).dynamic(tailKey);
    publish(
      sid,
      "item",
      where({
        ...w,
        id: `wake:${job.id}`,
        text: base + tail,
        tail,
        tailKind: "append",
        ...(status === "cancelled" ? { status: "cancelled" } : {}),
      }),
    );
  }
}

/**
 * Inside a transaction: deliver pending `job` into `running` (callers
 * checked appendBlocker). `auto`: a Daisy wake Daisy appended by itself.
 * Returns the live input id.
 */
export function appendJob(
  store: Store,
  s: Session,
  job: any,
  running: any,
  publish: Publish,
  opts: { auto?: boolean } = {},
): string {
  const mid = id(),
    now = Date.now();
  store.run(
    "INSERT INTO live_inputs(id,job_id,request_id,text,status,created,context,source_job) VALUES(?,?,?,?,?,?,?,?)",
    mid,
    running.id,
    `append:${job.id}:${now}`,
    String(job.text || ""),
    "queued",
    now,
    job.context ?? null,
    job.id,
  );
  store.run("UPDATE jobs SET status='appended' WHERE id=?", job.id);
  forgetJump(store, s.id, job.id);
  store.run(
    "INSERT OR REPLACE INTO native_appends(job_id,session_id,input_id,into_job,state,own_turn,auto,withdraw,created) VALUES(?,?,?,?,'waiting',0,?,0,?)",
    job.id,
    s.id,
    mid,
    running.id,
    opts.auto ? 1 : 0,
    now,
  );
  mark(
    store,
    s.id,
    job,
    "appended",
    "server-sessions.append.tail.appended",
    publish,
    running.id,
  );
  return mid;
}

/** The Daisy job behind live input `input` (null: a plain steer). */
export function sourceOf(store: Store, input: any): any | null {
  if (!input?.source_job) return null;
  return store.one("SELECT * FROM jobs WHERE id=?", input.source_job) ?? null;
}
const row = (store: Store, jid: string) => {
  return store.one("SELECT * FROM native_appends WHERE job_id=?", jid);
};

/**
 * What the Runner gets for an appended job when it claims the input: the
 * job's text as its own turn would read it (its preamble — carried wakes,
 * group digest — first), attachments with their bytes, page context and
 * terminal runs. Kept reports and sidecar summaries are not taken: they
 * ride the next turn claimed.
 */
export function appendPayload(
  store: Store,
  job: any,
  into?: any,
  /** the mid-turn line, before her words (after the preamble). */
  lead = "",
) {
  // Re-review 2: a Daisy wake going into the owner's own turn reads as
  // queue-merge carries it — a labelled block, 资料、不是本人的指令, its body
  // fenced (<external_message>, clean) — never as her words. Into a wake's
  // own turn (same class) it is as that turn's own text is.
  // Hotfix 2: so does the owner's own wake going into any turn not of its
  // own class (the AI's own, another wake class's).
  const kind = mergeKind(store, job);
  const own =
    !!into &&
    kind !== "owner" &&
    (!into.origin || kind !== mergeKind(store, into));
  const body = own ? carryBlock(store, job, "append") : `${lead}${job.text}`;
  return {
    id: job.id,
    text: job.preamble ? `${job.preamble}\n\n${body}` : body,
    ...(job.context ? { context: JSON.parse(job.context) } : {}),
    ...(job.terminal ? { terminal: JSON.parse(job.terminal) } : {}),
    attachments: ((parse(job.attachments) || []) as string[])
      .map((aid) => store.one("SELECT * FROM attachments WHERE id=?", aid))
      .filter(Boolean)
      .map((a: any) => ({
        id: a.id,
        name: a.name,
        mime: a.mime,
        size: a.size,
        data: readFileSync(a.path).toString("base64"),
      })),
    ...(job.origin ? { origin: job.origin } : {}),
  };
}

/**
 * Added 2026-11-09: the one line the agent reads
 * before the owner's words when they go into a turn already running — so
 * it can tell they came mid-turn, and when. `sent`: when she sent them;
 * `appended`: when they were put into that turn (the `live_inputs` row),
 * shown only when it is a minute or more later. In this machine's time
 * zone, named (ADR-154; was Beijing time).
 */
export function midTurnMarker(sent: number, appended = sent, t: Translate = ownerT()): string {
  const hm = (x: number) => zoned(x, localTimeZone(x).offsetMinutes).hm;
  const zone = zoneName(localTimeZone(sent));
  return appended - sent >= 60_000
    ? t("server-sessions.append.midTurnLater", { sent: hm(sent), appended: hm(appended), zone })
    : t("server-sessions.append.midTurn", { sent: hm(sent), zone });
}
/** When she sent what claimed input `input` carries (earliest if merged). */
function sentAt(store: Store, input: any, source: any | null): number {
  const at = Number(input.created) || Date.now();
  if (source) return Number(source.created) || at;
  let merged: any = null;
  try {
    merged = store.one(
      "SELECT MIN(j.created) t FROM queue_merges m JOIN jobs j ON j.id=m.job_id WHERE m.into_input=?",
      input.id,
    )?.t;
  } catch {} // no queue_merges table yet: nothing merged

  return Math.min(at, Number(merged) || at);
}
/**
 * The mid-turn line for claimed input `input` of a running turn (plain
 * steer / merged steer: `source` null; appended job: `source`), or "" for
 * a Daisy wake. Only on the claim — stored text, bubbles and a requeued /
 * handed-back turn stay as she wrote them.
 */
export function midTurnLead(
  store: Store,
  input: any,
  source: any | null,
): string {
  // Her own words only — a Daisy wake's fenced label says where it is from.
  if (source && mergeKind(store, source) !== "owner") return "";
  const at = Number(input.created) || Date.now();
  const sid = String(source?.session_id || store.one("SELECT session_id FROM jobs WHERE id=?", input.job_id)?.session_id || "");
  const t = inSessionT(sid ? store.session(sid) : null);
  return `${midTurnMarker(sentAt(store, input, source), at, t)}\n\n`;
}

/**
 * Inside a transaction: the agent gave appended input `input` back (or
 * never got it) — its job is pending again, first in Daisy's queue, with
 * `reason` on the card. A job stopped / removed meanwhile stays so.
 * Returns whether it went back.
 */
export function restoreAppended(
  store: Store,
  sid: string,
  input: any,
  reason: string,
  publish: Publish,
): boolean {
  const job = sourceOf(store, input);
  store.run(
    "UPDATE live_inputs SET status='requeued',result=? WHERE id=?",
    JSON.stringify({ requeued: input.source_job, reason, restored: true }),
    input.id,
  );
  if (!job || job.status !== "appended") return false;
  // Review M1: 「移除」 was asked (withdrawing) and the agent never read it —
  // the removal wins; it is not put back in line.
  if (row(store, job.id)?.withdraw) {
    store.run(
      "UPDATE native_appends SET state='removed',withdraw=0 WHERE job_id=?",
      job.id,
    );
    dropQueuedJob(store, sid, job, publish);
    return false;
  }
  store.run("UPDATE jobs SET status='pending' WHERE id=?", job.id);
  store.run(
    "UPDATE native_appends SET state='returned',withdraw=0 WHERE job_id=?",
    job.id,
  );
  // First in line: before every jump still waiting.
  recordJump(store, sid, job.id, null, ownerT()("server-sessions.append.jumpNotRead"));
  const first = store.one(
    "SELECT MIN(created) n FROM queue_jump_order WHERE session_id=? AND job_id<>?",
    sid,
    job.id,
  )?.n;
  if (first != null)
    store.run(
      "UPDATE queue_jump_order SET created=? WHERE job_id=?",
      first - 1,
      job.id,
    );
  mark(
    store,
    sid,
    job,
    "queued",
    "server-sessions.append.tail.notRead",
    publish,
    null,
  );
  publish(sid, "item", {
    id: `append-back:${input.id}`,
    kind: "notice",
    text: inSessionT(store.session(sid))("server-sessions.append.backToQueue", { reason: reason.slice(0, 200) }),
    status: "complete",
    createdAt: Date.now(),
  });
  return true;
}

/**
 * Inside a transaction: the Runner's report for appended input `input` —
 * `started` (the agent read it; `ownTurn` = as a turn of its own after the
 * running one ended: that counts as a self-run turn, daily budget),
 * `completed`, `cancelled` (「移除」 got it back) or `kept` (it could not).
 */
export function appendState(
  store: Store,
  input: any,
  state: "started" | "completed" | "cancelled" | "kept",
  ownTurn: boolean,
  publish: Publish,
  remove: (job: any) => void,
): void | "stale" | "not-withdrawing" {
  const job = sourceOf(store, input);
  if (!job) return "stale";
  const sid = job.session_id,
    r = row(store, job.id);
  // Review L4: only the delivery this row stands for (an older input of a
  // job appended again is stale).
  if (!r || r.input_id !== input.id) return "stale";
  if (state === "kept") {
    if (r.withdraw)
      publish(sid, "item", {
        id: `append-kept:${input.id}`,
        kind: "notice",
        text: inSessionT(store.session(sid))("server-sessions.append.notRemoved"),
        status: "error",
        createdAt: Date.now(),
      });
    store.run("UPDATE native_appends SET withdraw=0 WHERE job_id=?", job.id);
    return;
  }
  if (state === "cancelled") {
    // Only an answer to 「移除」 (review L4); Claude cancelling by itself
    // comes as a hand-back (requeue).
    if (!r.withdraw) return "not-withdrawing";
    store.run(
      "UPDATE native_appends SET state='removed',withdraw=0 WHERE job_id=?",
      job.id,
    );
    store.run(
      "UPDATE live_inputs SET status='cancelled' WHERE id=? AND status<>'requeued'",
      input.id,
    );
    // Appended, or — review M1 — already handed back to the queue while
    // the removal was on its way: removed either way.
    if (job.status === "appended" || job.status === "pending") remove(job);
    return;
  }
  if (["completed", "removed"].includes(r.state) && state === "started") return;
  if (r.state !== "started" && r.state !== "completed") {
    store.run(
      "UPDATE native_appends SET state='started',own_turn=?,withdraw=0,read_at=? WHERE job_id=?",
      ownTurn ? 1 : 0,
      Date.now(),
      job.id,
    );
    if (job.status === "appended")
      mark(
        store,
        sid,
        job,
        "accepted",
        ownTurn ? "server-sessions.append.tail.ownTurn" : "server-sessions.append.tail.merged",
        publish,
        undefined,
        "read",
      );
    else if (job.status === "interrupted") {
      // Read just as 「停止」 landed (a known race). Read
      // wins — a callback kept for the next turn by that
      // stop is not delivered again.
      unkeep(store, sid, job);
      publish(sid, "item", {
        id: `append-late:${input.id}`,
        kind: "notice",
        text: inSessionT(store.session(sid))("server-sessions.append.readBeforeStop"),
        status: "complete",
        createdAt: Date.now(),
      });
    }
  }
  if (state === "completed") {
    store.run(
      "UPDATE native_appends SET state='completed' WHERE job_id=?",
      job.id,
    );
    if (job.status === "appended")
      store.run("UPDATE jobs SET status='completed' WHERE id=?", job.id);
  }
}

/**
 * Take a stopped callback's text back out of `kept_callbacks` (read). Any
 * callback wake job (the generic frame, ADR-157): the core knows no
 * plugin's kinds or id shapes.
 */
function unkeep(store: Store, sid: string, job: any) {
  const cb = callbackJob(job.request_id);
  if (!cb || !job.text) return;
  const key = `${sid}:${cb.scheduleId}`,
    cur = store.one("SELECT text FROM kept_callbacks WHERE id=?", key);
  if (!cur) return;
  const rest = String(cur.text).replace(String(job.text), "").trim();
  if (!rest) store.run("DELETE FROM kept_callbacks WHERE id=?", key);
  else if (rest !== String(cur.text).trim())
    store.run("UPDATE kept_callbacks SET text=? WHERE id=?", rest, key);
}

/** Appended inputs of job `jid` that 「移除」 asked back (pulse `withdraw`). */
export function withdrawals(store: Store, jid: string): string[] {
  return store
    .all(
      "SELECT input_id FROM native_appends WHERE into_job=? AND withdraw=1 AND state='waiting'",
      jid,
    )
    .map((r: any) => r.input_id);
}

/**
 * 「移除」 of an appended job (DELETE …/queue/:jid). `removed`: Daisy took
 * it back by itself (the Runner had not claimed it yet); `withdrawing`: the
 * agent is asked for it back (Claude `cancel_async_message`); otherwise
 * why it cannot be removed.
 */
export function removeAppended(
  store: Store,
  s: Session,
  job: any,
): "removed" | "withdrawing" | string {
  const r = row(store, job.id);
  const input = r
    ? store.one("SELECT * FROM live_inputs WHERE id=?", r.input_id)
    : null;
  if (!r || !input) return "removed";
  if (r.state !== "waiting") return appendReadWhy();
  if (input.status === "queued") {
    store.run("UPDATE live_inputs SET status='cancelled' WHERE id=?", input.id);
    store.run(
      "UPDATE native_appends SET state='removed' WHERE job_id=?",
      job.id,
    );
    return "removed";
  }
  if (!inputCaps(store, s)?.withdraw)
    return ownerT()("server-sessions.append.handedOver");
  store.run("UPDATE native_appends SET withdraw=1 WHERE job_id=?", job.id);
  return "withdrawing";
}

/**
 * an appended row the agent has read is part of the running turn
 * — not a queue row: no 移除 / 撤回, no 插队, no merge (「如果它
 * 已经被处理了，为什么还能被移除或者插队」).
 */
export const appendReadWhy = (): string => ownerT()("server-sessions.append.readNoRemove");
/** why an appended row cannot be jumped / merged again. */
export function appendedWhy(store: Store, jid: string): string {
  return row(store, jid)?.state === "started"
    ? ownerT()("server-sessions.append.read")
    : ownerT()("server-sessions.append.waiting");
}
/** the agent has read appended job `jid` (state `started`). */
export function appendRead(store: Store, jid: string): boolean {
  return row(store, jid)?.state === "started";
}

/** `GET …/queue` fields of an appended row. */
export function appendView(store: Store, jid: string) {
  const r = row(store, jid);
  return {
    appended: true as const,
    appendState: r?.withdraw ? ("withdrawing" as const) : ("waiting" as const),
    // Review L2: read already (`started`), still running in this turn.
    appendLabel:
      ownerT()(r?.state === "started" ? "server-sessions.append.label.read" : "server-sessions.append.label.waiting"),
    ...(r?.auto ? { appendAuto: true as const } : {}),
  };
}

/**
 * A Daisy wake Daisy appends by itself: plugin callbacks,
 * timers and background reports (origin schedule), approval decisions,
 * classifier retries and other event wakes (origin collab). Not group
 * requests (delivery tokens, per job), not 「快速了解」, not the owner's.
 */
export function daisyWake(job: any): boolean {
  const rid = String(job.request_id || "");
  if (/^(chat|understanding|op|steer):/.test(rid)) return false;
  return job.origin === "schedule" || job.origin === "collab";
}
/**
 * Inside a transaction, while `running` (a turn of session `s`) is claimed
 * for input: the first pending Daisy wake that can go into it natively,
 * appended (one per call; the Runner asks every second). Off with session
 * setting `autoAppendWakes: false`. A wake given back once (returned) is
 * left to Daisy's queue. Budget: a wake reaches the queue only within the
 * daily budget (scheduler `wake` → kept-callback deferral otherwise); appended,
 * it is no turn of its own unless the agent runs it as one (`ownTurn`).
 */
export function autoAppend(
  store: Store,
  s: Session,
  running: any,
  publish: Publish,
): string | null {
  if (s.settings?.autoAppendWakes === false) return null;
  if (!inputCaps(store, s)?.append) return null;
  const rows = store.all(
    "SELECT * FROM jobs WHERE session_id=? AND status='pending' AND cancel=0 ORDER BY created,rowid",
    s.id,
  );
  const jumped = jumpedList(store, s.id);
  const ordered = [
    ...jumped.map((x) => rows.find((r: any) => r.id === x)).filter(Boolean),
    ...rows.filter((r: any) => !jumped.includes(r.id)),
  ];
  for (const job of ordered)
    if (autoAppendable(store, s, job, running))
      return appendJob(store, s, job, running, publish, { auto: true });
  return null;
}
/**
 * Whether `autoAppend` takes pending `job` into `running` by itself — also
 * what the queue view says (hotfix 2 review L1: a row it will take shows no
 * 「下一轮」; one it will not keeps its real reason or its 插队 button).
 */
export function autoAppendable(
  store: Store,
  s: Session,
  job: any,
  running: any,
): boolean {
  if (s.settings?.autoAppendWakes === false) return false;
  if (!daisyWake(job)) return false;
  if (row(store, job.id)) return false; // given back once: Daisy's queue
  return !appendBlocker(store, s, job, running);
}

/**
 * Take pending (or appended) job `j` out of the queue: Daisy
 * wakes it carried go back, what was merged into it goes with it, its
 * bubble / wake marker says so. Inside a transaction.
 */
export function dropQueuedJob(
  store: Store,
  sid: string,
  j: any,
  publish: Publish,
) {
  store.run("UPDATE jobs SET status='interrupted' WHERE id=?", j.id);
  // Review 3: a removed message is no longer in line as a jump.
  forgetJump(store, sid, j.id);
  // Daisy wakes it carried go back to the queue; what was
  // merged into it (her own words) goes with it.
  restoreCarried(store, j.id, publish);
  removedWithParts(store, j.id, publish);
  // A Daisy wake (timer, background end, plugin callback …) has no
  // bubble: its marker says it was removed and never started — not a
  // stray 「你 · 已取消」 bubble at the end, after which the wake read as
  // started and the trace bar left the running turn (「正在准备…」).
  const wake = store.one(
    "SELECT data FROM items WHERE session_id=? AND id=?",
    sid,
    `wake:${j.id}`,
  );
  if (
    wake &&
    !store.one(
      "SELECT 1 FROM items WHERE session_id=? AND id=?",
      sid,
      `user:${j.id}`,
    )
  ) {
    const d = JSON.parse(wake.data || "{}");
    const tail = inSessionT(store.session(sid))("server-sessions.append.tail.notDelivered");
    publish(sid, "item", {
      ...d,
      id: `wake:${j.id}`,
      status: "cancelled",
      text: wakeBase(d) + tail,
      tail,
      tailKind: "append",
    });
    return;
  }
  const item = JSON.parse(
    store.one(
      "SELECT data FROM items WHERE session_id=? AND id=?",
      sid,
      `user:${j.id}`,
    )?.data || "{}",
  );
  publish(sid, "item", {
    ...item,
    id: `user:${j.id}`,
    kind: "user",
    // The bubble's own words (the job's text may hold merged parts).
    text: typeof item.text === "string" ? item.text : j.text,
    status: "cancelled",
    createdAt: j.created,
  });
}
