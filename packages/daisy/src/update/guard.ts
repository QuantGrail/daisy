/**
 * P5-06 (ADR-145): the start guard — run by main.ts before the rest of
 * Daisy is even loaded, so a newer Daisy that cannot load at all is still
 * caught.
 *
 * `update/pending.json` (package.ts) says a switch from one release to
 * another is under way. At start:
 *
 * - this process is the new release (`to`): a trial. The start is counted;
 *   it must become healthy (daemon.ts: the local face answers its health
 *   check and the Runner synced once) within CONFIRM_MS. Healthy: the
 *   switch is recorded `updated` and the pending record goes. An exit
 *   before that (other than the owner's stop, 0, or a restart, 75), the
 *   timeout, or MAX_STARTS starts that never got there: the previous
 *   release's package is installed again (synchronously, `npm install -g`),
 *   and Daisy restarts into it — exit 75 to systemd / launchd, a successor
 *   started here for `daisy start`'s background process.
 * - this process is the previous release (`from`) after such a rollback:
 *   the outcome is recorded `rolled-back` (with why) and the record goes.
 * - anything else (a third release was installed by hand): recorded
 *   `failed`, record gone.
 *
 * The database is not restored: structure changes only add (ADR-108 §5),
 * so the previous release runs on the database as the new one left it. The
 * copy taken before the update stays in `backups/` for a manual restore.
 */
import { daisyEnv } from "../../../contracts/src/env.ts";
import { ownerT } from "../platform/language.ts";
import { withoutFileSettings } from "../platform/settings.ts";
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { startUmaskEnv } from "../platform/umask.ts";
import {
  CONFIRM_MS,
  MAX_STARTS,
  clearPending,
  installPackageSync,
  logFileOf,
  readPending,
  record,
  writePending,
  type Pending,
} from "./package.ts";

export type GuardAction =
  | { kind: "none" }
  /** We are the new release: count this start, wait for health. */
  | { kind: "trial"; pending: Pending }
  /** We are the new release and it is given up: install the previous one. */
  | { kind: "rollback"; pending: Pending; reason: string }
  /** We are the previous release, back after a rollback (or an undone switch). */
  | { kind: "back"; pending: Pending }
  /** Neither: another release runs; the switch is over. */
  | { kind: "stale"; pending: Pending; reason: string }
  /** We are the new release; a rollback was tried and failed: keep running it. */
  | { kind: "stuck"; pending: Pending; reason: string };

/** Pure: what the guard does with this pending record for release `own`. */
export function decideGuard(p: Pending | null, own: string | null): GuardAction {
  if (!p) return { kind: "none" };
  if (p.to === own) {
    if (p.rolledBack && !p.rolledBack.ok)
      return {
        kind: "stuck",
        pending: p,
        reason: ownerT()("server-update.guard.rollbackFailed", { from: p.from ?? "?", why: p.rolledBack.error ?? "?", own: String(own) }),
      };
    const reason = p.failed ?? (p.starts >= MAX_STARTS ? ownerT()("server-update.guard.tooManyStarts", { n: p.starts }) : null);
    if (reason) {
      if (!p.fromPackage) return { kind: "stuck", pending: p, reason: ownerT()("server-update.guard.noWayBack", { why: reason }) };
      return { kind: "rollback", pending: p, reason };
    }
    return { kind: "trial", pending: p };
  }
  if (p.from !== null && p.from === own) return { kind: "back", pending: p };
  return {
    kind: "stale",
    pending: p,
    reason: own
      ? ownerT()("server-update.guard.stale", { to: p.to, own })
      : ownerT()("server-update.guard.staleUnmarked", { to: p.to }),
  };
}

/** How this process comes back after it exits (without restart.ts: the guard stays small). */
export function comeback(env: Record<string, string | undefined>): "respawn" | "manager" | "none" {
  if (env.DAISY_RESPAWN === "1") return "respawn";
  if (env.INVOCATION_ID || env.DAISY_LAUNCHD_LABEL || daisyEnv("DAISY_RUNNER_SELF_RESTART", env) === "1") return "manager";
  return "none";
}

/**
 * Start this process's successor (the same command, detached, its output
 * to the log) — for a Daisy that `daisy start` runs as a background
 * process, where nothing else would start it again. It waits for this
 * process to be gone (DAISY_RESPAWN_AFTER) before taking the data lock.
 */
export function startSuccessor(dataDir: string, env: NodeJS.ProcessEnv = process.env): number | undefined {
  const log = logFileOf(dataDir);
  mkdirSync(dirname(log), { recursive: true, mode: 0o700 });
  const fd = openSync(log, "a", 0o600);
  try {
    const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
      cwd: process.cwd(),
      // P6-11 review: the successor reads runner.json itself.
      // P6-15 (ADR-158): the start's file-creation mask, for the AI's programs.
      env: { ...withoutFileSettings(env), ...startUmaskEnv(), DAISY_RESPAWN_AFTER: String(process.pid) },
      detached: true,
      stdio: ["ignore", fd, fd],
      windowsHide: true,
    });
    child.unref();
    return child.pid;
  } finally {
    closeSync(fd);
  }
}

/** A successor waits for the process that started it (its exit releases the data lock). */
export async function waitForPredecessor(env: Record<string, string | undefined>, timeoutMs = 180_000): Promise<void> {
  const pid = Number(env.DAISY_RESPAWN_AFTER);
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;
  const until = Date.now() + timeoutMs;
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e: any) {
      return e?.code === "EPERM";
    }
  };
  while (alive() && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
}

export interface GuardOptions {
  dataDir: string;
  own: string | null;
  env?: NodeJS.ProcessEnv;
  confirmMs?: number;
  log?: (s: string) => void;
  /** Tests: instead of npm / exiting / spawning. */
  install?: (prefix: string, tgz: string) => { ok: boolean; error?: string };
  exit?: (code: number) => void;
  successor?: () => void;
}

export class StartGuard {
  private pending: Pending | null = null;
  private confirmed = false;
  private failed: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private onExit = (code: number) => this.exited(code);
  constructor(private o: GuardOptions) {}
  private log(s: string) {
    (this.o.log ?? ((l: string) => process.stderr.write(l + "\n")))(`[update] ${s}`);
  }
  /** This start is a new release's trial (confirm() is due). */
  get trial() {
    return !!this.pending && !this.confirmed;
  }
  get record(): Pending | null {
    return this.pending;
  }
  /**
   * At start. Returns false when this process must not go on (it rolled
   * back and exits / exited for the previous release).
   */
  begin(): boolean {
    const { dataDir, own } = this.o;
    const p = readPending(dataDir);
    const a = decideGuard(p, own);
    switch (a.kind) {
      case "none":
        return true;
      case "back":
        record(dataDir, {
          id: a.pending.id,
          from: a.pending.to,
          to: a.pending.from ?? "?",
          result: "rolled-back",
          reason: a.pending.failed ?? ownerT()("server-update.guard.unhealthy"),
          backup: a.pending.backup,
          by: a.pending.by,
        });
        clearPending(dataDir);
        this.log(`rolled back to ${own} (${a.pending.to} did not run properly: ${a.pending.failed ?? "?"})`);
        return true;
      case "stale":
      case "stuck":
        record(dataDir, { id: a.pending.id, from: a.pending.from, to: a.pending.to, result: "failed", reason: a.reason, backup: a.pending.backup, by: a.pending.by });
        clearPending(dataDir);
        this.log(a.reason);
        return true;
      case "rollback":
        this.rollback(a.pending, a.reason);
        this.restartIntoPrevious();
        return false;
      case "trial": {
        this.pending = { ...a.pending, starts: a.pending.starts + 1 };
        writePending(dataDir, this.pending);
        this.log(`new release ${own}, start ${this.pending.starts}: it must run properly within ${Math.round((this.o.confirmMs ?? CONFIRM_MS) / 1000)} s, or it is rolled back to ${a.pending.from}`);
        process.on("exit", this.onExit);
        this.timer = setTimeout(() => {
          const seconds = Math.round((this.o.confirmMs ?? CONFIRM_MS) / 1000);
          this.failed = ownerT()("server-update.guard.notHealthyIn", { seconds });
          this.log(`new release ${own} did not run properly within ${seconds} s: exiting, rolling back to ${a.pending.from}`);
          (this.o.exit ?? process.exit)(1);
        }, this.o.confirmMs ?? CONFIRM_MS);
        (this.timer as any).unref?.();
        return true;
      }
    }
  }
  /** Change the record of the trial (daemon.ts: the backup taken at start). */
  amend(patch: Partial<Pending>) {
    if (!this.pending) return;
    this.pending = { ...this.pending, ...patch };
    writePending(this.o.dataDir, this.pending);
  }
  /** The import of the rest of Daisy failed: this release cannot run. */
  loadFailed(e: unknown) {
    if (this.trial) this.failed = ownerT()("server-update.smokeFailed", { why: String((e as Error)?.message ?? e).slice(0, 300) });
  }
  /** daemon.ts: healthy (local face answers, Runner synced). */
  confirm(): boolean {
    if (!this.pending || this.confirmed) return false;
    this.confirmed = true;
    clearTimeout(this.timer);
    process.off("exit", this.onExit);
    const p = this.pending;
    record(this.o.dataDir, { id: p.id, from: p.from, to: p.to, result: "updated", backup: p.backup, by: p.by });
    clearPending(this.o.dataDir);
    this.log(`switched to ${p.to} (before: ${p.from ?? "?"}; database backup from before the update: ${p.backup ?? "none"})`);
    return true;
  }
  /** An exit before the confirmation (not the owner's stop, 0; not a restart, 75 — unless the timeout's). */
  private exited(code: number) {
    if (this.confirmed || !this.pending) return;
    if (!this.failed && (code === 0 || code === 75)) return;
    const reason = this.failed ?? ownerT()("server-update.guard.exited", { code });
    this.rollback(this.pending, reason);
    if (comeback(this.o.env ?? process.env) === "respawn") (this.o.successor ?? (() => startSuccessor(this.o.dataDir, this.o.env)))();
  }
  /** Install the previous package again (synchronously: also from an exit handler). */
  private rollback(p: Pending, reason: string) {
    const failed = { ...p, failed: reason };
    if (!p.fromPackage || !p.prefix) {
      writePending(this.o.dataDir, { ...failed, rolledBack: { at: Date.now(), ok: false, error: ownerT()("server-update.guard.noPreviousPackage") } });
      this.log(`${reason}; there is no package of the previous release, so it cannot be rolled back`);
      return;
    }
    this.log(`${reason}: rolling back to ${p.from} (npm install -g ${p.fromPackage})`);
    const r = (this.o.install ?? ((prefix, tgz) => installPackageSync(prefix, tgz)))(p.prefix, p.fromPackage);
    writePending(this.o.dataDir, { ...failed, rolledBack: { at: Date.now(), ok: r.ok, ...(r.error ? { error: r.error } : {}) } });
    if (!r.ok) this.log(`rolling back failed: ${r.error}. By hand: npm install -g ${p.fromPackage}`);
  }
  /** After a rollback at start: let the previous release start. */
  private restartIntoPrevious() {
    const how = comeback(this.o.env ?? process.env);
    const exit = this.o.exit ?? process.exit;
    if (how === "respawn") {
      (this.o.successor ?? (() => startSuccessor(this.o.dataDir, this.o.env)))();
      exit(75);
    } else if (how === "manager") exit(75);
    else {
      this.log("rolled back to the previous release: start Daisy again");
      exit(1);
    }
  }
}

/** The guard of this process (main.ts sets it; daemon.ts confirms through it). */
export let guard: StartGuard | null = null;
export const setGuard = (g: StartGuard | null) => (guard = g);

let synced: () => void = () => {};
/** Resolves at the in-process Runner's first state sync (worker.ts). */
export const runnerSynced = new Promise<void>((r) => (synced = r));
export const markRunnerSynced = () => synced();
