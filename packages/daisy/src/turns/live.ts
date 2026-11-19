import { turnT } from "../harness/model-switch.ts";
import { daisyEnv } from "../../../contracts/src/env.ts";
import { createHash } from "node:crypto";
import type {
  LiveActivity,
  RunnerJob,
} from "../../../contracts/src/index.ts";
import {
  liveSettings,
  requestedAutoCompact,
  takesThreshold,
  tokens as k,
  type LiveAgent,
  type LiveHooks,
  type MakeAgent,
} from "../harness/shared.ts";
import { claudeAgent } from "../harness/claude.ts";
import { bypassMode } from "../../../contracts/src/approvals.ts";
import { codexAgent } from "../harness/codex.ts";
import { acpAgentFor } from "../harness/acp.ts";
import { ACP_AGENTS } from "../../../contracts/src/acp-harnesses.ts";
import { launchGuideKey, toolsFor } from "../tools/daisy-tools.ts";
import { log } from "../observe/log.ts";
const makers: Record<string, MakeAgent> = {
  claude: claudeAgent,
  codex: codexAgent,
  // P4-10: every ACP harness through the one generic adapter.
  ...Object.fromEntries(ACP_AGENTS.map((a) => [a, acpAgentFor(a)])),
};
/** Default: offline after 30 minutes without activity and nothing pending. */
export const LIVE_IDLE_MS = 30 * 60_000;
/**
 * background tasks keep a process online — but not
 * unattended for ever: no turn for this long and nothing pending but
 * background tasks (no timer) → idle-offline anyway; the tasks end with
 * the process. DAISY_BG_KEEPALIVE_MS overrides.
 */
export const BG_KEEPALIVE_MS = 4 * 3600_000;
export const bgKeepaliveReason = (ms: number) =>
  ms >= 3600_000
    ? turnT()("server-turns.live.bgKeepaliveHours", { n: Math.round(ms / 3600_000) })
    : turnT()("server-turns.live.bgKeepaliveMinutes", { n: Math.max(1, Math.round(ms / 60_000)) });
/** Slots full: an Agent idle this long may give its slot up. */
export const EVICT_IDLE_MS = 2 * 60_000;
/** Why a process of the old identity went offline after 「换身份」. */
export const retireReason = () => turnT()("server-turns.live.retire");
/** the process runs in bypassPermissions and this job may not. */
export const permissionChanged = () => turnT()("server-turns.live.permissionChanged");
/** … and the process still has background work (it is not killed for it). */
export const permissionWait = () => turnT()("server-turns.live.permissionWait");
/** A job of the new identity while the old one's process runs a turn. */
export const otherIdentityBusy = () => turnT()("server-turns.live.otherIdentityBusy");
/** The old identity's process did not end in time: nothing copied. */
export const otherIdentityStuck = () => turnT()("server-turns.live.otherIdentityStuck");
/** What 立即重启 tells the turn it ends. */
export const restartNowReason = () => turnT()("server-turns.live.restartNow");
interface Entry {
  agent: LiveAgent;
  key: string;
  /** Launched in bypassPermissions (Claude bypass, Codex danger-full-access + never, Kimi yolo). */
  bypass: boolean;
  profileId: string;
  /** The job the process serves (no prompt, attachments or capability): restarts are made from it. */
  job: RunnerJob;
  cwd: string;
  /** Auto-compact threshold the process started with (null = CLI default). */
  autoCompact: number | null;
  /** A new identity value from the control plane, applied when idle (or now). */
  want?: { tokens: number | null; now: boolean };
  /** An idle restart is starting the new process. */
  restarting?: boolean;
  /**
   * the conversation switched identity; this process (the old
   * one's) ends once idle, the next message starts the new identity.
   */
  retire?: boolean;
  /** End the attached job with a reason (立即重启). */
  interrupt?: (reason: string) => void;
  /** The Agent started a turn; its job has not attached yet. */
  waking: boolean;
  outbox: { id: string; type: "item"; data: any }[];
  sending: boolean;
  /** Background task activity, refreshed at most every 5 s. */
  activity?: { at: number; items: LiveActivity[] };
  /** when a turn last attached / ended (the keep-alive cap). */
  lastTurn: number;
  /** going offline for the keep-alive cap (its notice on the way). */
  expiring?: boolean;
}
/** How often a report reads the background tasks' progress / output. */
const ACTIVITY_MS = 5000;
type Api = (path: string, body?: any) => Promise<any>;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
/**
 * What makes a process unusable for a job: identity, workspace, sandbox
 * mode. Model, effort and permission mode are applied before the next turn
 * where the Agent's CLI here allows it (`liveSettings`); otherwise
 * they are part of the key and a change restarts the process (it resumes
 * the session). Turning bypass on or off always restarts.
 */
export function liveKey(job: RunnerJob, cwd: string) {
  const p = job.profile,
    agent = job.session.agent,
    live = liveSettings(agent);
  return JSON.stringify([
    agent,
    p.id,
    p.configDir || "",
    p.authMode,
    p.authHeader || "",
    p.baseUrl || "",
    createHash("sha256")
      .update(p.apiKey || "")
      .digest("hex"),
    cwd,
    job.session.workspaceMode || "shared",
    live.permissionMode === "native"
      ? bypassMode({ ...p, agent })
        ? "bypass"
        : ""
      : p.permissionMode || "",
    p.sandboxMode || "",
    live.effort === "native" ? "" : p.reasoningEffort || "",
    // Kimi cannot go back to "the default" model live (review r1 #7).
    live.model === "native" ? "" : p.model || "",
    // model slots are environment, read at launch.
    agent === "claude" ? JSON.stringify(p.modelSlots ?? {}) : "",
    // Daisy's tools and a resident's guidance are given at launch.
    toolsFor(job).length,
    // with the layered prompt, `guide.stable` — an L1 update of
    // the org core alone does not restart the process.
    launchGuideKey(job),
    // P4-07 (ADR-126): a resident's tools and directories are launch
    // arguments (absent for every other session: their key is unchanged).
    ...(job.residentLimits ? [JSON.stringify([job.residentLimits.tools, job.residentLimits.dirs])] : []),
  ]);
}
/**
 * Online sessions, runner side: one Agent process per session
 * kept between turns. Jobs attach to it (`acquire`); turns the Agent starts
 * by itself become jobs through the control plane (`wake`); state goes to
 * the control plane on every change and every 10 s; idle processes with
 * nothing pending go offline after `idleMs`.
 */
/** A job as kept by an online process: nothing a restart does not need. */
function kept(job: RunnerJob): RunnerJob {
  const { context: _c, terminal: _t, ...rest } = job;
  return { ...rest, text: "", attachments: [] };
}
export class LiveRegistry {
  private entries = new Map<string, Entry>();
  private closed: { sessionId: string; reason: string }[] = [];
  private reportTimer: ReturnType<typeof setTimeout> | undefined;
  private reporting: Promise<void> | null = null;
  private again = false;
  /** false: the control plane has no live routes; every turn is offline. */
  supported = true;
  constructor(
    private opts: {
      api: Api;
      /** Run a job the control plane leased for an Agent-started turn. */
      runWake: (job: RunnerJob) => void;
      enabled: boolean;
      idleMs: number;
      evictIdleMs?: number;
      /** the unattended background cap (default BG_KEEPALIVE_MS). */
      keepaliveMs?: number;
      /** Tests: how a process is made (default: the Agent's adapter). */
      make?: MakeAgent;
    },
  ) {}
  get enabled() {
    return this.opts.enabled && this.supported;
  }
  /**
   * The process that serves this job (a new one when there is none).
   * `interrupt`: how 立即重启 ends this job, until release.
   */
  acquire(
    job: RunnerJob,
    cwd: string,
    interrupt?: (reason: string) => void,
  ): LiveAgent {
    const sid = job.session.id,
      key = liveKey(job, cwd);
    let e = this.entries.get(sid);
    if (e) e.waking = false;
    // a process of another identity never serves this job — not
    // even an Agent-started one (its key, quota and directory are the old
    // identity's). Busy: the job fails rather than run there.
    if (e && !e.agent.closed && e.profileId !== job.profile.id) {
      if (e.agent.busy()) throw Error(otherIdentityBusy());
      e.agent.stop();
      this.drop(sid, e, retireReason());
      e = undefined;
    }
    // Bypass policy (2026-11-03): a process launched in bypass never
    // serves a job that may not run in bypass — not an Agent-started turn,
    // not while busy. A safer process may serve any job (the usual
    // settings rule below still restarts it for its owner's turns).
    // Busy: stopped, the job fails. Idle: restarted. Background work still
    // running: kept (not killed), the job fails until it is done.
    if (e && !e.agent.closed && e.bypass && !bypassMode(job.profile)) {
      if (e.agent.busy()) {
        e.agent.stop();
        this.entries.delete(sid);
        this.changed();
        throw Error(permissionChanged());
      }
      if (!this.idle(e)) throw Error(permissionWait());
      e.agent.stop();
      this.entries.delete(sid);
      e = undefined;
    }
    if (
      e &&
      (e.agent.closed ||
        (e.key !== key && job.origin !== "agent" && !e.agent.busy()) ||
        // a new auto-compact threshold restarts the process at the
        // next message only when nothing would be lost (no turn, nothing in
        // the background); otherwise it waits for the process to go idle.
        (job.origin !== "agent" &&
          takesThreshold(job.session.agent) &&
          requestedAutoCompact(job) !== e.autoCompact &&
          this.idle(e)))
    ) {
      // Settings changed (or the process died): resume in a new process.
      e.agent.stop();
      this.entries.delete(sid);
      e = undefined;
    }
    if (e) e.job = kept(job);
    else e = this.create(sid, job, cwd);
    e.interrupt = interrupt;
    e.lastTurn = Date.now();
    e.expiring = false;
    this.changed();
    return e.agent;
  }
  private hooks(sid: string, entry: Entry): LiveHooks {
    return {
      wake: (reason) => void this.wake(sid, entry, reason),
      emit: (type, data) => {
        if (type !== "item") return;
        const box = entry.outbox,
          at = box.findIndex((x) => x.data.id === data.id);
        const event = { id: crypto.randomUUID(), type, data };
        if (at >= 0 && !entry.sending) box[at] = event;
        else box.push(event);
        void this.flush(sid, entry);
      },
      changed: () => this.changed(),
      closed: (reason) => this.drop(sid, entry, reason),
      // a rename in the native session → Daisy (the owner's);
      // a few tries, then null (the adapter lets Daisy's title win again).
      title: async (title, base) => {
        for (let attempt = 0; ; attempt++)
          try {
            const r = await this.opts.api(`/sessions/${sid}/title`, {
              title,
              source: "native",
              base,
            });
            return {
              applied: !!r?.applied,
              ...(typeof r?.title === "string" ? { title: r.title } : {}),
            };
          } catch (e: any) {
            // A refusal (4xx) is an answer that will not change: no retry.
            const status = Number(e?.status) || 0;
            if (
              attempt >= 2 ||
              entry.agent?.closed ||
              (status >= 400 && status < 500)
            ) {
              log.error(
                `Session ${sid}: native rename not reported (${String(e?.message || e).slice(0, 200)})`,
              );
              return null;
            }
            await new Promise((r) => setTimeout(r, 1000 * 3 ** attempt));
          }
      },
    };
  }
  private create(sid: string, job: RunnerJob, cwd: string) {
    const live = this.enabled;
    const entry: Entry = {
      key: liveKey(job, cwd),
      bypass: bypassMode(job.profile),
      profileId: job.profile.id,
      job: kept(job),
      cwd,
      autoCompact: requestedAutoCompact(job),
      waking: false,
      outbox: [],
      sending: false,
      lastTurn: Date.now(),
      agent: null as unknown as LiveAgent,
    };
    entry.agent = (this.opts.make ?? makers[job.session.agent])(
      job,
      cwd,
      live
        ? this.hooks(sid, entry)
        : {
            wake: () => {},
            emit: () => {},
            changed: () => {},
            closed: () => {},
          },
      live,
    );
    if (live) this.entries.set(sid, entry);
    return entry;
  }
  /**
   * Nothing would be lost by restarting this process now (the
   * same idleness as quiet()): no turn, no Agent-started turn on its way,
   * nothing in the background, no unsent events.
   */
  private idle(e: Entry) {
    return (
      !e.agent.busy() &&
      !e.waking &&
      !e.restarting &&
      !e.agent.pending().length &&
      !e.outbox.length &&
      !e.sending
    );
  }
  /**
   * Apply new auto-compact thresholds: each process waiting for
   * one restarts once idle — or now, when its owner pressed 立即重启 — and
   * resumes its conversation with the new value.
   */
  applyPending() {
    for (const [sid, e] of [...this.entries])
      if (e.retire && this.idle(e)) this.close(sid, retireReason());
      else if (e.want && (e.want.now || this.idle(e))) this.restart(sid, e);
  }
  private restart(sid: string, e: Entry) {
    const want = e.want!,
      now = want.now && !this.idle(e);
    e.want = undefined;
    const nativeId = e.agent.nativeId?.() ?? e.job.session.nativeId ?? null;
    const job: RunnerJob = {
      ...e.job,
      session: { ...e.job.session, nativeId },
      profile: { ...e.job.profile, autoCompactTokens: want.tokens },
    };
    const old = e.agent;
    if (now) e.interrupt?.(restartNowReason());
    old.stop(now ? restartNowReason() : undefined);
    this.entries.delete(sid);
    if (!nativeId || !old.warm) {
      // Nothing to resume here: the next message starts with the new value.
      this.closed.push({
        sessionId: sid,
        reason:
          turnT()("server-turns.live.thresholdUpdated"),
      });
      this.changed();
      return;
    }
    const entry = this.create(sid, job, e.cwd);
    entry.restarting = true;
    // A restart is not activity: idle-offline and eviction keep counting
    // from the old process's last turn (review N4).
    const carried = old.lastActivity,
      warmFrom = Date.now();
    entry.agent.lastActivity = carried;
    this.hooks(sid, entry).emit("item", {
      id: `${e.job.id}:restart:${Date.now()}`,
      kind: "notice",
      category: "lifecycle",
      name: turnT()("server-turns.live.restartName"),
      text: turnT()(now ? "server-turns.live.restartedNow" : "server-turns.live.restartedIdle", {
        threshold: want.tokens === null ? turnT()("server-turns.live.cliDefault") : turnT()("server-turns.live.window", { window: k(want.tokens) }),
      }),
      status: "complete",
      createdAt: Date.now(),
    });
    this.changed();
    void (async () => {
      try {
        // The old process lets go of the conversation first.
        await Promise.race([
          old.stopped?.(),
          new Promise((r) => setTimeout(r, 5000)),
        ]);
        if (this.entries.get(sid) === entry && !entry.agent.closed)
          await entry.agent.warm!();
      } catch (err: any) {
        if (this.entries.get(sid) === entry)
          this.close(
            sid,
            turnT()("server-turns.live.restartFailed", { error: String(err?.message || err).slice(0, 160) }),
          );
      } finally {
        entry.restarting = false;
        // Start-up output (hook events) is not the user's activity either.
        if (!entry.agent.busy() && entry.agent.lastActivity >= warmFrom)
          entry.agent.lastActivity = carried;
        this.changed();
      }
    })();
  }
  /**
   * before a job of `profileId` touches the conversation's files
   * (the transcript carry), a process of another identity ends — and has
   * let go of them. Busy: refused (OTHER_IDENTITY_BUSY).
   */
  async retireOther(sid: string, profileId: string, timeoutMs = 5000) {
    const e = this.entries.get(sid);
    if (!e || e.agent.closed || e.profileId === profileId) return;
    if (e.agent.busy()) throw Error(otherIdentityBusy());
    e.agent.stop();
    this.drop(sid, e, retireReason());
    // Its files must be let go of before anything copies them.
    const gone = await Promise.race([
      (e.agent.stopped?.() ?? Promise.resolve()).then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), timeoutMs)),
    ]);
    if (!gone) throw Error(otherIdentityStuck());
  }
  /** After a turn: offline mode ends the process, a dead one is dropped. */
  async release(sid: string, agent: LiveAgent) {
    const e = this.entries.get(sid);
    if (!e || e.agent !== agent) {
      agent.stop();
      await agent.stopped?.();
      return;
    }
    e.interrupt = undefined;
    e.lastTurn = Date.now();
    if (agent.closed) this.drop(sid, e, turnT()("server-turns.live.processEnded"));
    else if (!this.enabled) this.close(sid, "");
    else this.applyPending();
    this.changed();
  }
  /** The job for an Agent-started turn did not attach (it failed first). */
  abandon(sid: string) {
    const e = this.entries.get(sid);
    if (!e) return;
    e.waking = false;
    e.agent.discardWake?.();
  }
  /**
   * the process of session `sid` if one is up — for what it does
   * beside its turns (「只问」 side questions, 「回退」 in place); never
   * started or attached here.
   */
  peek(sid: string): LiveAgent | null {
    const e = this.entries.get(sid);
    return e && !e.agent.closed && !e.restarting && !e.retire ? e.agent : null;
  }
  /** Close one session's process (operations that rewrite its state). */
  close(sid: string, reason: string) {
    const e = this.entries.get(sid);
    if (!e) return;
    e.agent.stop();
    this.drop(sid, e, reason);
  }
  /** Close idle processes of an identity whose configuration changed. */
  closeProfile(profileId: string, reason: string) {
    for (const [sid, e] of this.entries)
      if (e.profileId === profileId && !e.agent.busy()) this.close(sid, reason);
  }
  /** Sessions with an Agent process here: each holds a slot. */
  sessions() {
    return [...this.entries.keys()];
  }
  /**
   * P1-02: online sessions with work in hand — a turn, an Agent-started
   * turn on its way, background work, unsent events (what a restart would
   * end; the same idleness as quiet()).
   */
  busySessions() {
    return [...this.entries]
      .filter(([, e]) => !this.idle(e))
      .map(([sid]) => sid);
  }
  /**
   * Slots full and a new session waits: the longest-idle Agent with no turn,
   * nothing in the background and no Agent-started turn on its way goes
   * offline (its history stays; the next message brings it back). None
   * idle `minIdleMs` yet: the new session keeps waiting.
   */
  evictIdle(
    now = Date.now(),
    minIdleMs = this.opts.evictIdleMs ?? EVICT_IDLE_MS,
  ) {
    let pick: [string, Entry] | null = null,
      // else one whose background ran unattended past the cap.
      stale: [string, Entry] | null = null;
    for (const entry of this.entries) {
      const a = entry[1].agent;
      if (this.unattended(entry[1], now)) {
        if (!stale || entry[1].lastTurn < stale[1].lastTurn) stale = entry;
        continue;
      }
      if (
        a.busy() ||
        entry[1].waking ||
        entry[1].restarting ||
        entry[1].expiring ||
        a.pending().length ||
        now - a.lastActivity < minIdleMs
      )
        continue;
      if (!pick || a.lastActivity < pick[1].agent.lastActivity) pick = entry;
    }
    if (!pick && stale) {
      this.expire(stale[0], stale[1]);
      return stale[0];
    }
    if (!pick) return null;
    this.close(
      pick[0],
      turnT()("server-turns.live.evicted"),
    );
    return pick[0];
  }
  /** `reason`: tell the control plane why (the next report carries it). */
  closeAll(reason = "") {
    for (const [sid, e] of this.entries) {
      e.agent.stop();
      this.entries.delete(sid);
      if (reason) this.closed.push({ sessionId: sid, reason });
    }
  }
  /**
   * Nothing would be lost if every process went now: no turn, nothing in
   * the background, no Agent-started turn on its way, no unsent events.
   * `ignorePending`: the native timers / background tasks do not
   * count (a restart that waited long enough for them).
   */
  quiet(ignorePending = false) {
    for (const e of this.entries.values())
      if (
        e.agent.busy() ||
        e.waking ||
        e.restarting ||
        (!ignorePending && e.agent.pending().length) ||
        e.outbox.length ||
        e.sending
      )
        return false;
    return true;
  }
  private drop(sid: string, e: Entry, reason: string) {
    if (this.entries.get(sid) !== e) return;
    this.entries.delete(sid);
    if (reason) this.closed.push({ sessionId: sid, reason });
    this.changed();
  }
  private get keepaliveMs() {
    return (
      this.opts.keepaliveMs ??
      (Number(daisyEnv("DAISY_BG_KEEPALIVE_MS")) || BG_KEEPALIVE_MS)
    );
  }
  /**
   * only background tasks keep it online (no timer, no turn, no
   * wake on its way) and no turn for longer than the keep-alive cap.
   */
  private unattended(e: Entry, now: number) {
    if (e.expiring || e.agent.busy() || e.waking || e.restarting) return false;
    const pending = e.agent.pending();
    return (
      pending.length > 0 &&
      pending.every((t) => t.kind === "task") &&
      now - e.lastTurn > this.keepaliveMs
    );
  }
  /** Offline for the cap: a notice in the session first, then the process ends. */
  private expire(sid: string, e: Entry) {
    if (e.expiring) return;
    e.expiring = true;
    const reason = bgKeepaliveReason(this.keepaliveMs);
    this.hooks(sid, e).emit("item", {
      id: `${e.job.id}:bg-keepalive:${Date.now()}`,
      kind: "notice",
      category: "lifecycle",
      name: turnT()("server-turns.live.bgKeepaliveName"),
      text: reason,
      status: "complete",
      createdAt: Date.now(),
    });
    void (async () => {
      // The notice goes out before the process (and the session's live
      // channel) does — at most a few seconds.
      void this.flush(sid, e);
      const end = Date.now() + 5000;
      while ((e.outbox.length || e.sending) && Date.now() < end)
        await delay(100);
      if (this.entries.get(sid) === e && !e.agent.busy())
        this.close(sid, reason);
      else e.expiring = false;
    })();
  }
  /** Idle-offline (call periodically); thresholds waiting for idleness. */
  sweep(now = Date.now()) {
    this.applyPending();
    for (const [sid, e] of this.entries)
      if (this.unattended(e, now)) this.expire(sid, e);
      else if (
        !e.agent.busy() &&
        !e.agent.pending().length &&
        now - e.agent.lastActivity > this.opts.idleMs
      )
        this.close(
          sid,
          turnT()("server-turns.live.idleOffline", { minutes: Math.round(this.opts.idleMs / 60_000) }),
        );
  }
  /** The Agent started a turn: ask the control plane for its job. */
  private async wake(sid: string, e: Entry, reason: string) {
    e.waking = true;
    this.changed();
    let wait = 500,
      missing = 0;
    while (e.waking && this.entries.get(sid) === e && !e.agent.closed) {
      try {
        // which identity this process runs (the control plane
        // refuses a wake from the old one after 换身份).
        const { job } = await this.opts.api(`/live/${sid}/wake`, {
          reason,
          profileId: e.profileId,
        });
        e.waking = false;
        this.opts.runWake(job);
        return;
      } catch (err: any) {
        const status = err?.status;
        // 404: not (yet / again) listed online here — e.g. right after the
        // control plane dropped a missed report; the next report fixes it.
        if (status === 404 && ++missing <= 12) void this.report();
        else if (status === 404 || status === 410 || status === 403) {
          // Session gone / not online here: nobody can see this turn.
          // or it switched identity — this process is the old one's.
          e.waking = false;
          this.close(
            sid,
            // By the refusal's code (its text is in the owner's language).
            err?.code === "gone"
              ? retireReason()
              : // D-36: no PIN set — the turn it started may not run.
                err?.code === "pin_not_set"
                ? String(err.message)
                : turnT()("server-turns.live.unavailable"),
          );
          return;
        }
        // 409: a turn of this session is running or about to attach; it
        // takes the Agent's turn over. Otherwise the network: retry.
        await delay(wait);
        wait = Math.min(wait * 2, 5000);
      }
    }
  }
  /** Between-turn item updates (session channel). */
  private async flush(sid: string, e: Entry) {
    if (e.sending) return;
    e.sending = true;
    try {
      while (e.outbox.length) {
        const batch = e.outbox.slice(0, 50);
        try {
          await this.opts.api(`/live/${sid}/events`, { events: batch });
          e.outbox.splice(0, batch.length);
        } catch (err: any) {
          if (err?.status && err.status < 500) {
            e.outbox.splice(0, batch.length);
            continue;
          }
          await delay(1000);
          if (!this.entries.has(sid)) return;
        }
      }
    } finally {
      e.sending = false;
    }
  }
  private async activity(e: Entry) {
    const pending = e.agent.pending();
    if (!e.agent.activity || !pending.some((t) => t.kind === "task")) return [];
    const now = Date.now();
    if (!e.activity || now - e.activity.at >= ACTIVITY_MS)
      e.activity = {
        at: now,
        items: await e.agent.activity().catch(() => e.activity?.items ?? []),
      };
    // Only tasks still pending (one may have ended since the last read).
    const ids = new Set(pending.map((t) => t.id));
    return e.activity.items.filter((a) => ids.has(a.id));
  }
  /** State changed: report soon. */
  changed() {
    if (!this.opts.enabled) return;
    clearTimeout(this.reportTimer);
    this.reportTimer = setTimeout(() => void this.report(), 300);
  }
  report(): Promise<void> {
    if (this.reporting) {
      this.again = true;
      return this.reporting;
    }
    this.reporting = (async () => {
      const closed = this.closed.splice(0);
      try {
        const sessions = await Promise.all(
          [...this.entries].map(async ([sessionId, e]) => ({
            sessionId,
            since: e.agent.since,
            lastActivity: e.agent.lastActivity,
            busy: e.agent.busy(),
            pending: e.agent.pending().slice(0, 100),
            activity: (await this.activity(e)).slice(0, 100),
            // the identity it runs; another one → `retire`.
            profileId: e.profileId,
            // what the process runs with; the control plane answers
            // with the identity's value when it differs (`apply`).
            ...(takesThreshold(e.job.session.agent)
              ? {
                  autoCompact: {
                    tokens: e.autoCompact,
                    ...(e.want ? { want: e.want.tokens } : {}),
                    ...(e.restarting ? { restarting: true } : {}),
                  },
                }
              : {}),
          })),
        );
        const r = await this.opts.api("/live", { sessions, closed });
        this.supported = true;
        if (Array.isArray(r.apply)) {
          // The control plane's list is the whole truth: a value set back
          // before the restart cancels it.
          const asked = new Map<
            string,
            { tokens: number | null; now: boolean }
          >();
          for (const a of r.apply)
            if (
              a &&
              typeof a.sessionId === "string" &&
              (a.tokens === null ||
                (Number.isInteger(a.tokens) && a.tokens > 0))
            )
              asked.set(a.sessionId, { tokens: a.tokens, now: a.now === true });
          for (const [sid, e] of this.entries) {
            const a = asked.get(sid);
            e.want =
              a && a.tokens !== e.autoCompact && !e.restarting
                ? { tokens: a.tokens, now: a.now || !!e.want?.now }
                : undefined;
          }
          this.applyPending();
        }
        if (Array.isArray(r.retire)) {
          // The whole truth, like `apply`: switched back = keep it.
          const gone = new Set(
            r.retire.filter((x: unknown) => typeof x === "string"),
          );
          for (const [sid, e] of this.entries) e.retire = gone.has(sid);
          this.applyPending();
        }
        // 「停止」 on one background task (each asked once).
        if (Array.isArray(r.stopTasks))
          for (const t of r.stopTasks) {
            const e =
              t && typeof t.sessionId === "string"
                ? this.entries.get(t.sessionId)
                : undefined;
            if (!e?.agent.stopTask || typeof t.id !== "string") continue;
            void e.agent
              .stopTask(t.id)
              .catch(() => false)
              .finally(() => this.changed());
          }
        for (const sid of r.stop || [])
          // Not in the middle of a turn: a message sent right after 「下线」
          // must not be cut off (review r1 #5).
          if (!this.entries.get(sid)?.agent.busy())
            this.close(sid, turnT()("server-turns.live.offlineAsked"));
      } catch (err: any) {
        if (err?.status === 404) {
          // An older control plane: no online sessions.
          this.supported = false;
          return;
        }
        this.closed.unshift(...closed);
      }
    })().finally(() => {
      this.reporting = null;
      if (this.again) {
        this.again = false;
        this.changed();
      }
    });
    return this.reporting;
  }
}
