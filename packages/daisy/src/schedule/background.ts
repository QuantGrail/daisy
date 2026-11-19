import {
  processTree,
  signalTree,
  trackGroup,
  untrackGroup,
} from "../platform/process-groups.ts";
import { type ChildProcess } from "node:child_process";
import { spawnTree } from "../platform/spawn.ts";
import { windowsShell } from "../platform/windows/cmdline.ts";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";
import { SCHEDULE_LIMITS } from "../../../contracts/src/scheduler.ts";
import { ownerT } from "../platform/language.ts";
type Api = (path: string, body?: any) => Promise<any>;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Plain text: no escape sequences; a progress bar keeps its last state. */
function plain(s: string) {
  return s
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .split("\n")
    .map((l) => l.split("\r").filter(Boolean).at(-1) ?? "")
    .join("\n");
}
export interface BackgroundSpec {
  id: string;
  sessionId: string;
  kind: "bash" | "monitor";
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Prefix that applies the session's protection (bwrap / codex sandbox). */
  wrap: string[];
  timeoutMs: number;
  /** monitor: only stdout lines matching this wake the Agent. */
  pattern?: string;
  logPath: string;
}
interface Proc {
  spec: BackgroundSpec;
  /** Started (ms; R2 review N-L2: a restart stops only what ran long enough). */
  startedAt: number;
  /**
   * Its exit event is queued (R2 review N-L1): until then it stays listed
   * (sync, stopAll), also while a signal-killed exit waits out its grace.
   */
  exitQueued?: boolean;
  child: ChildProcess;
  log: WriteStream;
  tail: string;
  bytes: number;
  reason?: string;
  /** Canceled by the Agent / owner / control plane: no report is waited for. */
  quiet?: boolean;
  /** The Runner stops: report nothing (its next start reports it lost). */
  silent?: boolean;
  /** stopped for a Runner restart — reported as `lost`, with its output. */
  lost?: boolean;
  lines: string[];
  partial: string;
  flushTimer?: ReturnType<typeof setTimeout>;
  timer: ReturnType<typeof setTimeout>;
  killTimer?: ReturnType<typeof setTimeout>;
  /** Events to the control plane, in order. */
  outbox: any[];
  sending: boolean;
}
const TAIL = 64 * 1024;
/** How long a signal-killed exit waits for the Runner's own SIGTERM. */
const SIGNAL_GRACE_MS = 1000;
/** A stopped command's processes get SIGTERM, then SIGKILL after this. */
export const KILL_GRACE_MS = 5000;
/** Review 2026-11-03: a background command's log stops growing here … */
export const LOG_CAP = 64 * 1024 * 1024;
/** … and a monitor keeps at most this many lines between two reports. */
const LINES_CAP = 1000;
/**
 * Daisy background commands and monitors, Runner side: each runs
 * as its own process group in the session's workspace under the session's
 * protection, its output in a file the Agent can read; output lines
 * (monitor) and the exit go to the control plane, which wakes the Agent.
 * Nothing survives a Runner restart: the next sync reports them `lost`.
 */
export class BackgroundManager {
  private procs = new Map<string, Proc>();
  /** Set once the Runner is gone: send loops end. */
  private closed = false;
  /**
   * why a new one may not start right now (a restart waited long
   * enough for background work and stops it), or null.
   */
  draining: string | null = null;
  /**
   * The Runner is being stopped (SIGTERM / SIGINT: set synchronously by the
   * signal handler). systemd's KillMode=control-group signals the children
   * too, often before the Runner's own stopAll: a child killed by a signal
   * without a reason of ours is then reported `lost`, not failed (review M2).
   */
  stopping = false;
  /** The control plane has no scheduler (an older one): nothing to sync. */
  supported = true;
  /** This process's start: the control plane takes older rows it lacks as lost. */
  private since = Date.now();
  /** `limit`: this node's own cap on what runs at once (the control plane has one too). */
  constructor(
    private api: Api,
    readonly limit: number = SCHEDULE_LIMITS.nodeBackground,
  ) {}
  /** Why a new background command / monitor cannot start here now (null: it can). */
  refusal(): string | null {
    if (this.draining) return this.draining;
    if (this.procs.size >= this.limit)
      return ownerT()("server-schedule.bg.nodeFull", { n: this.procs.size, max: this.limit });
    return null;
  }
  get size() {
    return this.procs.size;
  }
  running() {
    return [...this.procs.keys()];
  }
  /** P1-02: what runs, per session (what a restart would end). */
  list() {
    return [...this.procs.values()].map((p) => ({
      id: p.spec.id,
      sessionId: p.spec.sessionId,
      since: p.startedAt,
    }));
  }
  has(id: string) {
    return this.procs.has(id);
  }
  start(spec: BackgroundSpec) {
    mkdirSync(dirname(spec.logPath), { recursive: true, mode: 0o700 });
    const log = createWriteStream(spec.logPath, { flags: "a", mode: 0o600 });
    // P5-05: Windows has no /bin/sh — Git Bash, else PowerShell (cmdline.ts).
    const win = process.platform === "win32" ? windowsShell(spec.env ?? process.env) : null;
    const shell = win ? [win.file, ...win.args(spec.command)] : ["/bin/sh", "-c", spec.command];
    const [cmd, ...args] = [...spec.wrap, ...shell];
    // Its own group (Linux / macOS) or Job Object (Windows).
    const child = spawnTree(cmd!, args, {
      cwd: spec.cwd,
      env: win ? { ...spec.env, ...win.env } : spec.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // P1-02 / C-4: recorded, so a next start can end it if this process is killed.
    trackGroup(child.pid);
    child.once("exit", () => untrackGroup(child.pid));
    const p: Proc = {
      spec,
      startedAt: Date.now(),
      child,
      log,
      tail: "",
      bytes: 0,
      lines: [],
      partial: "",
      outbox: [],
      sending: false,
      timer: setTimeout(
        () =>
          this.kill(
            spec.id,
            ownerT()("server-schedule.bg.timedOut", { s: Math.round(spec.timeoutMs / 1000) }),
          ),
        spec.timeoutMs,
      ),
    };
    this.procs.set(spec.id, p);
    let filter: RegExp | null = null;
    try {
      filter = spec.pattern ? new RegExp(spec.pattern) : null;
    } catch {}
    const take = (chunk: Buffer, stdout: boolean) => {
      const s = chunk.toString("utf8");
      if (p.bytes < LOG_CAP) {
        log.write(chunk);
        if (p.bytes + chunk.length >= LOG_CAP)
          log.write(
            `\n${ownerT()("server-schedule.bg.logCapped", { mb: LOG_CAP / 1048576 })}\n`,
          );
      }
      p.bytes += chunk.length;
      p.tail = (p.tail + s).slice(-TAIL);
      if (spec.kind !== "monitor" || !stdout) return;
      const parts = (p.partial + s).split("\n");
      p.partial = parts.pop() ?? "";
      for (const raw of parts) {
        const line = plain(raw).trimEnd();
        if (!line || (filter && !filter.test(line))) continue;
        p.lines.push(line);
      }
      if (p.lines.length > LINES_CAP)
        p.lines.splice(0, p.lines.length - LINES_CAP);
      if (p.lines.length && !p.flushTimer)
        p.flushTimer = setTimeout(
          () => this.flushLines(p),
          SCHEDULE_LIMITS.monitorBatchMs,
        );
    };
    child.stdout!.on("data", (c: Buffer) => take(c, true));
    child.stderr!.on("data", (c: Buffer) => take(c, false));
    let ended = false;
    const end = (
      code: number | null,
      error?: Error,
      signal?: NodeJS.Signals | null,
    ) => {
      if (ended) return;
      ended = true;
      clearTimeout(p.timer);
      clearTimeout(p.killTimer);
      if (spec.kind === "monitor" && p.partial.trim()) {
        const line = plain(p.partial).trimEnd();
        if (!filter || filter.test(line)) p.lines.push(line);
        p.partial = "";
      }
      this.flushLines(p);
      log.end();
      const exit = () => {
        // Killed by a signal that was not ours while the Runner stops.
        const stopped = !p.reason && !error && !!signal && this.stopping;
        const reason =
          p.reason ||
          (error ? ownerT()("server-schedule.bg.startFailed", { error: error.message.slice(0, 200) }) : undefined) ||
          (stopped ? ownerT()("server-schedule.bg.runnerStopped") : undefined);
        p.exitQueued = true;
        this.queue(p, {
          type: "exit",
          text: plain(p.tail).slice(-SCHEDULE_LIMITS.tailChars),
          exitCode: p.reason || error || stopped ? null : code,
          ...(reason ? { reason } : {}),
          ...(p.lost || stopped ? { lost: true } : {}),
          outputPath: spec.logPath,
        });
        this.reap(p);
      };
      // A signal not of ours: the Runner's own SIGTERM may still be on its
      // way (the whole cgroup is signalled at once) — a moment's grace.
      if (!p.reason && !error && signal && !this.stopping)
        setTimeout(exit, SIGNAL_GRACE_MS);
      else exit();
    };
    child.on("error", (e) => end(null, e));
    child.on("close", (code, signal) => end(code, undefined, signal));
    return p;
  }
  private flushLines(p: Proc) {
    clearTimeout(p.flushTimer);
    p.flushTimer = undefined;
    if (!p.lines.length) return;
    let lines = p.lines.splice(0);
    const dropped = Math.max(0, lines.length - SCHEDULE_LIMITS.monitorLines);
    if (dropped) lines = lines.slice(-SCHEDULE_LIMITS.monitorLines);
    let text = (dropped ? ownerT()("server-schedule.bg.linesDropped", { n: dropped }) + "\n" : "") + lines.join("\n");
    if (text.length > SCHEDULE_LIMITS.monitorChars)
      text = "…" + text.slice(-SCHEDULE_LIMITS.monitorChars);
    this.queue(p, { type: "output", text });
  }
  private queue(p: Proc, event: any) {
    if (p.silent || (p.quiet && event.type === "output")) return;
    p.outbox.push(event);
    void this.send(p);
  }
  private async send(p: Proc) {
    if (p.sending) return;
    p.sending = true;
    try {
      let wait = 500;
      while (p.outbox.length && !this.closed) {
        try {
          await this.api(
            `/sessions/${p.spec.sessionId}/schedules/${p.spec.id}/event`,
            p.outbox[0],
          );
          p.outbox.shift();
          wait = 500;
        } catch (e: any) {
          // Gone / refused: nobody to tell. Otherwise the network: retry.
          if (e?.status && e.status < 500) p.outbox.shift();
          else {
            await delay(wait);
            wait = Math.min(wait * 2, 30_000);
          }
        }
      }
    } finally {
      p.sending = false;
      this.reap(p);
    }
  }
  /** Gone from the list once its exit is queued and everything is sent. */
  private reap(p: Proc) {
    if (
      p.exitQueued &&
      !p.sending &&
      (!p.outbox.length || this.closed || p.silent) &&
      this.procs.get(p.spec.id) === p
    )
      this.procs.delete(p.spec.id);
  }
  /**
   * Stop one: SIGTERM to its group and to every process under it (C1-c: a
   * child that left the group — its own session, a daemon — is found by
   * parent, on macOS through `ps` as on Linux through /proc), SIGKILL to
   * whatever of that is still there after 5 s, also once the command
   * itself has exited (its leftovers are reparented and would run on).
   */
  kill(id: string, reason: string, quiet = false) {
    const p = this.procs.get(id);
    if (!p || p.child.exitCode !== null || p.child.signalCode !== null) return;
    p.reason ??= reason;
    p.quiet ||= quiet;
    if (p.killTimer) return; // already being stopped
    // Windows: the child is the job helper; ending it ends the whole job.
    const tree = processTree(p.child.pid);
    const signal = (s: NodeJS.Signals) => {
      try {
        if (p.child.pid && process.platform !== "win32")
          process.kill(-p.child.pid, s);
        else p.child.kill(s);
      } catch {}
    };
    signal("SIGTERM");
    signalTree(tree, "SIGTERM");
    p.killTimer = setTimeout(() => signal("SIGKILL"), KILL_GRACE_MS);
    // Not cleared by the exit (unlike killTimer): pid + start time checked.
    if (tree.length) {
      const t = setTimeout(() => signalTree(tree, "SIGKILL"), KILL_GRACE_MS);
      (t as any).unref?.();
    }
  }
  /** The end of an item's output (the `output` tool). */
  /** Only the session's own (review 2026-11-03: `sessionId` must match). */
  output(id: string, chars = 4000, sessionId?: string) {
    const p = this.procs.get(id);
    if (!p || (sessionId !== undefined && p.spec.sessionId !== sessionId))
      return null;
    return {
      text: plain(p.tail).slice(-Math.max(200, Math.min(chars, TAIL))),
      bytes: p.bytes,
      running: p.child.exitCode === null && p.child.signalCode === null,
      path: p.spec.logPath,
    };
  }
  /** Runner exit: stop everything (the next start reports them lost). */
  killAll(reason: string) {
    for (const [id, p] of this.procs) {
      p.silent = true;
      this.kill(id, reason, true);
    }
  }
  /**
   * the Runner restarts. Stop everything and report each one as
   * `lost` with its output's end (the control plane keeps the report until
   * the Agent can be woken); after `waitMs` whatever is still unsent is left
   * to the next start's sync (also `lost`, without output). Resolves when
   * all were reported or the time is up.
   */
  async stopAll(reason: string, waitMs = 8000) {
    this.stopping = true;
    for (const [id, p] of this.procs) {
      // Only what still runs is lost (review L1: one that exited by itself
      // keeps its own exit code; a quiet, canceled one stays quiet).
      if (p.child.exitCode === null && p.child.signalCode === null) {
        p.lost = true;
        this.kill(id, reason);
      } else if (p.child.pid && process.platform !== "win32")
        // Exited, but something it started holds its output open.
        try {
          process.kill(-p.child.pid, "SIGTERM");
        } catch {}
    }
    const until = Date.now() + waitMs;
    while (this.procs.size && Date.now() < until) await delay(50);
    this.close();
  }
  /**
   * stop everything running now for a restart, each reported as
   * `lost` with its output's end; the Runner keeps going (and exits once
   * idle).
   */
  interruptAll(reason: string, startedBefore = Infinity) {
    let left = 0;
    for (const [id, p] of this.procs)
      if (p.child.exitCode === null && p.child.signalCode === null) {
        // R2 review N-L2: one started later has its own time to run.
        if (p.startedAt >= startedBefore) {
          left++;
          continue;
        }
        p.lost = true;
        this.kill(id, reason);
      }
    return left;
  }
  /** When the oldest still-running one started (ms), or null. */
  oldestRunning(): number | null {
    let t: number | null = null;
    for (const p of this.procs.values())
      if (p.child.exitCode === null && p.child.signalCode === null)
        t = t === null ? p.startedAt : Math.min(t, p.startedAt);
    return t;
  }
  /** Nothing more is sent (the Runner is gone); what still runs is killed. */
  close() {
    this.closed = true;
    this.killAll(ownerT()("server-schedule.bg.runnerGone"));
  }
  /**
   * Tell the control plane what runs here; stop what it says should not
   * (canceled, session archived / closed / deleted). Rows older than this
   * process that it does not list were lost with the previous one.
   */
  async sync() {
    if (!this.supported) return;
    try {
      // Also the ended ones whose exit has not reached the control plane
      // yet (review M3): not taken for lost, their real exit follows.
      const running = [...this.procs.keys()];
      const r = await this.api("/schedules/sync", {
        running,
        since: this.since,
      });
      for (const id of r.cancel || []) this.kill(id, ownerT()("server-schedule.bg.canceled"), true);
    } catch (e: any) {
      if (e?.status === 404) this.supported = false;
      throw e;
    }
  }
}
