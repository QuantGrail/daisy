import { daisyEnv } from "../../../contracts/src/env.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { processName } from "../platform/proc-table.ts";

/**
 * Self-upgrade to an installed release (2026-10-30; P1-02: of the whole
 * process, was the Runner's). A release swaps the code directory (its
 * `.release` = the commit) but a running process keeps the modules it
 * loaded, so it would serve old behaviour indefinitely. Instead it watches
 * the installed release and, once it differs from the one it started
 * with, exits as soon as it is completely idle; systemd
 * (`Restart=on-failure`) starts the installed release. A restart ends the
 * harness processes too (one process, D-02), so «idle» is strict: an
 * update never interrupts a turn (原则 2 — an interrupted turn is never
 * replayed); it waits, however long.
 *
 * Idle means nothing at all is in flight here: no job (turn, operation,
 * terminal, Agent-started turn), login, shell command, recovery transport,
 * title call, and every online Agent is quiet (no turn, nothing in the
 * background, no wake on its way, no unsent events). Sessions survive: their
 * history and native ids are on the control plane, the next message resumes
 * them in a fresh process, exactly like any Runner restart.
 */

/** EX_TEMPFAIL: non-zero, so `Restart=on-failure` starts the new release. */
export const RESTART_EXIT = 75;
/** Continuous idleness required before restarting. */
export const RESTART_IDLE_MS = 60_000;
/** A new release must stay installed this long (a failed deploy swaps back). */
export const RELEASE_SETTLE_MS = 60_000;
/** How often the release marker is read. */
const CHECK_MS = 5_000;

/** `.release` of the code this module was loaded from. */
export const DEFAULT_RELEASE_FILE = fileURLToPath(
  new URL("../../../../.release", import.meta.url),
);

/** The installed release, or null (no marker, directory being swapped). */
export function readRelease(file: string): string | null {
  try {
    const value = readFileSync(file, "utf8").trim();
    return /^[\w.+-]{1,100}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Started by systemd as a service (it sets INVOCATION_ID, and the parent is
 * the service manager): only then does an exit mean a restart. A Runner run
 * by hand (`npm start`) never exits by itself.
 */
export function supervisedBySystemd(
  env: Record<string, string | undefined> = process.env,
  // P5-04: the parent's name from /proc on Linux, `ps` on macOS.
  parentName = () => processName(process.ppid) ?? "",
) {
  if (daisyEnv("DAISY_RUNNER_SELF_RESTART", env) === "0") return false;
  if (daisyEnv("DAISY_RUNNER_SELF_RESTART", env) === "1") return true;
  if (!env.INVOCATION_ID) return false;
  try {
    return parentName() === "systemd";
  } catch {
    return false;
  }
}

export interface UpgradeOptions {
  file?: string;
  enabled: boolean;
  idleMs?: number;
  settleMs?: number;
  checkMs?: number;
  read?: (file: string) => string | null;
}

export class UpgradeWatch {
  /** The release this process started with (null: unknown, never restarts). */
  readonly started: string | null;
  readonly enabled: boolean;
  private file: string;
  private read: (file: string) => string | null;
  private idleMs: number;
  private settleMs: number;
  private checkMs: number;
  private checkedAt = -Infinity;
  /** A different installed release and since when it is unchanged. */
  private seen: { release: string; since: number } | null = null;
  private idleSince: number | null = null;
  constructor(opts: UpgradeOptions) {
    this.file = opts.file || DEFAULT_RELEASE_FILE;
    this.read = opts.read || readRelease;
    this.idleMs = opts.idleMs ?? RESTART_IDLE_MS;
    this.settleMs = opts.settleMs ?? RELEASE_SETTLE_MS;
    this.checkMs =
      opts.checkMs ?? Math.min(CHECK_MS, Math.max(100, this.settleMs / 4));
    this.started = this.read(this.file);
    this.enabled = opts.enabled && !!this.started;
  }
  /** The installed release when it is not the one this process runs. */
  outdated(now = Date.now()): string | null {
    if (!this.enabled) return null;
    if (now - this.checkedAt >= this.checkMs) {
      this.checkedAt = now;
      const current = this.read(this.file);
      if (!current || current === this.started) this.seen = null;
      else if (this.seen?.release !== current)
        this.seen = { release: current, since: now };
    }
    return this.seen?.release ?? null;
  }
  /** P5-06: the installed release went back (a failed switch): read it again now. */
  recheck() {
    this.checkedAt = -Infinity;
    this.seen = null;
  }
  /**
   * Call on every loop pass, before claiming anything, with whether the
   * Runner is idle right now. Returns the release to restart into once the
   * code is outdated, the new release has settled and the Runner has been
   * idle without a break for `idleMs`; otherwise null.
   */
  due(idle: boolean, now = Date.now()): string | null {
    if (!idle) this.idleSince = null;
    else if (this.idleSince === null) this.idleSince = now;
    const target = this.outdated(now);
    if (!target || !this.seen || now - this.seen.since < this.settleMs)
      return null;
    if (this.idleSince === null || now - this.idleSince < this.idleMs)
      return null;
    return target;
  }
}
