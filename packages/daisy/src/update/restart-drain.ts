import { SCHEDULE_LIMITS } from "../../../contracts/src/scheduler.ts";
import { log as daisyLog } from "../observe/log.ts";
/**
 * background work no longer holds a restart forever (P1-02: a
 * restart of the whole process; it ends every harness process too).
 *
 * A restart that waits for the Runner to be idle (a new installed release,
 * a built auto-update, the owner's 「空闲时重启」) used to wait as long as any
 * Daisy background command / monitor or native background task ran — a
 * monitor with a day's timeout, or a Claude Code cron, kept old code
 * running for days. Now the wait for *background* work is bounded:
 *
 * - While a restart is pending, the time the Runner spends idle *but for*
 *   background work is added up; once it reaches `waitMs` (default 30
 *   minutes, DAISY_RUNNER_RESTART_WAIT_MS / NodeConfig.restartWaitMs) the
 *   wait is over. Time with a turn, login, shell command etc. running does
 *   not count (review M4): a long turn neither uses up the background
 *   work's time nor makes new background work be refused; short wakes in
 *   between (a monitor's) only pause the clock.
 * - Once the time is up and the Runner is idle but for background work,
 *   new background commands are refused with a reason, the running ones
 *   are stopped and reported to their
 *   sessions as `lost` with their output's end (the control plane keeps the
 *   report until the Agent can be woken), native background
 *   tasks no longer count — and the usual idle period runs before the exit.
 * - The restart going away (request canceled, release reverted) resets it.
 */
export class RestartDrain {
  /** Time a pending restart has spent idle but for background work (ms). */
  private waited = 0;
  private last: { at: number; base: boolean } | null = null;
  private said = false;
  /** When the wait was over (ms), or null. */
  expiredAt: number | null = null;
  constructor(
    readonly waitMs: number = SCHEDULE_LIMITS.restartWaitMs,
    private log: (line: string) => void = daisyLog.info,
  ) {}
  /**
   * Every loop pass: whether a restart is pending, whether the Runner is
   * idle but for background work (`base`) and whether background work is
   * there (`holding`). Returns whether the wait is over.
   */
  tick(
    pending: boolean,
    base: boolean,
    holding = base,
    now = Date.now(),
  ): boolean {
    if (!pending) {
      if (this.last && this.said)
        this.log("Runner restart no longer waiting (request withdrawn or release unchanged)");
      this.waited = 0;
      this.last = null;
      this.said = false;
      this.expiredAt = null;
      return false;
    }
    if (this.last?.base) this.waited += Math.max(0, now - this.last.at);
    this.last = { at: now, base };
    if (base && holding && !this.said) {
      this.said = true;
      this.log(
        `Runner restart pending: waiting for background tasks to end (at most ${Math.round(this.waitMs / 60_000)} min once idle, then they are stopped and reported to their sessions)`,
      );
    }
    if (this.expired()) this.expiredAt ??= now;
    return this.expired();
  }
  /**
   * Background work started before this may be stopped now (R2 review
   * N-L2): what was there when the wait ran out, or what has run `waitMs`
   * by itself since — not one started while the node was busy afterwards.
   */
  stopBefore(now = Date.now()) {
    return this.expiredAt === null
      ? -Infinity
      : Math.max(this.expiredAt, now - this.waitMs + 1);
  }
  expired() {
    return this.last !== null && this.waited >= this.waitMs;
  }
  /** Idle time still to wait (ms), or null when no restart is pending. */
  remaining() {
    return this.last === null ? null : Math.max(0, this.waitMs - this.waited);
  }
}
