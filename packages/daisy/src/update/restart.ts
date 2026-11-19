import { daisyEnv } from "../../../contracts/src/env.ts";
import { FALLBACK_LANG, translator, type MessageKey, type Translate } from "../../../contracts/src/i18n.ts";
import { shippedPacks } from "../../../contracts/src/i18n-node.ts";
import { ownerT } from "../platform/language.ts";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { RestartCapability } from "../../../contracts/src/restart.ts";
import { supervisedBySystemd } from "./upgrade.ts";
import { processName } from "../platform/proc-table.ts";
import { LAUNCHD_ENV, LAUNCHD_LABEL_RE } from "../platform/launchd.ts";
import { WIN_SUPERVISOR_ENV, WIN_SUPERVISOR_RE } from "../platform/windows/autostart.ts";
import { log as daisyLog } from "../observe/log.ts";

/**
 * P1-02: restarting / updating the whole Daisy process.
 *
 * The control plane and the Runner are one process now (D-02). Whatever
 * restarts it — a newer installed release (upgrade.ts), an npm update
 * (package.ts, P5-06), or the owner asking (the local API, app/update.ts)
 * — also ends every harness process it started, so a turn
 * running then is cut off, and a cut-off turn is never replayed (原则 2).
 * Hence:
 *
 * - an update waits until nothing runs (the in-process Runner's own idle
 *   check: no turn, no card being waited on, no sign-in, no terminal
 *   command, no online Agent with work in hand; background commands /
 *   monitors only for a bounded time) — while something runs it
 *   is just pending, and `status()` names what it waits for;
 * - the owner may restart now: `request("now")` first lists what would be
 *   interrupted (`busy()`), and only a confirmed request goes ahead; the
 *   interrupted turns end as 「中断」 with a notice and are not replayed;
 * - the exit is 75 and the service manager starts the process again
 *   (systemd `Restart=on-failure`, launchd `KeepAlive` { SuccessfulExit:
 *   false } — P5-04 —, Windows' supervisor, `daisy start`'s respawn). A Daisy run by
 *   hand (`npm start`) is not supervised: exiting would only stop it, so a
 *   restart is refused there, and an update only waits.
 *
 * Replaces the earlier per-node 「重启」 (a request stored per node and handed
 * to that node's Runner in its heartbeat): there is one process and no
 * heartbeat.
 */

export type RestartMode = "idle" | "now";

/** Something running in this process that a restart would end. */
export interface BusyItem {
  kind: "turn" | "online" | "background" | "login" | "shell";
  /** The conversation it belongs to (sign-ins and shell commands: none). */
  sessionId?: string;
  /** Its job / login / request id. */
  id?: string;
  /** When it started (when known). */
  since?: number;
}

export interface RestartRequest {
  id: string;
  mode: RestartMode;
  at: number;
  /** Who asked (user id), for the log and the audit. */
  by?: string;
  /**
   * `now`: what the owner confirmed it may interrupt (busyKey of each).
   * Anything else running when it is carried out cancels it.
   */
  confirmed?: string[];
}

/** One busy item's identity: what a confirmation names. */
export const busyKey = (b: BusyItem) =>
  `${b.kind}:${b.id ?? b.sessionId ?? "?"}`;

/**
 * The confirmation of a 「立即重启」: the busy items it was shown, as a token
 * the caller hands back (base64url of the sorted keys).
 */
export function confirmToken(busy: BusyItem[]) {
  return Buffer.from(
    JSON.stringify([...new Set(busy.map(busyKey))].sort()),
  ).toString("base64url");
}
function confirmedKeys(token: unknown): string[] | null {
  if (typeof token !== "string" || token.length > 64_000) return null;
  try {
    const v = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    return Array.isArray(v) && v.every((x) => typeof x === "string") ? v : null;
  } catch {
    return null;
  }
}
/** Running now but not among what was confirmed (empty: covered). */
export function unconfirmed(busy: BusyItem[], confirmed: string[] = []) {
  const ok = new Set(confirmed);
  return busy.filter((b) => !ok.has(busyKey(b)));
}

/** A release the process restarts into once idle. */
export interface PendingUpdate {
  /** `release`: installed code changed; `update`: an auto-update is built. */
  kind: "release" | "update";
  target: string;
  since: number;
}

export type Supervision = Omit<RestartCapability, "version"> & {
  /** `reason` as a message key (said in the reader's language; `reason` is the owner's). */
  reasonKey?: MessageKey;
};

/**
 * Whether exiting means being started again, and by what. `supervised`:
 * runner.json `selfRestart`, else systemd / launchd (P5-04) /
 * DAISY_RUNNER_SELF_RESTART=1 (another supervisor that starts it again) / P5-06's
 * `respawn` (DAISY_RESPAWN=1: `daisy start`'s background process).
 *
 * launchd (macOS, `daisy autostart on`'s LaunchAgent, ADR-140): the plist
 * sets DAISY_LAUNCHD_LABEL to its label, and launchd (pid 1) is the
 * parent. Both are needed: a background process is reparented to pid 1
 * too (but `daisy start` drops the variable from its environment).
 *
 * Windows (P5-05, ADR-141): the helper's `supervise` (the HKCU Run entry,
 * or `daisy start` with it on) sets DAISY_WIN_SUPERVISOR to the entry's
 * name and is the parent (daisy-win); without --once (DAISY_RUNNER_SELF_RESTART
 * not "0") it starts Daisy again after exit 75. Manager "supervise".
 */
export function supervision(
  o: {
    selfRestart?: boolean;
    env?: Record<string, string | undefined>;
    parentName?: () => string;
    /** The parent's pid (launchd is 1). */
    ppid?: number;
    platform?: string;
    unit?: () => string | null;
  } = {},
): Supervision {
  const env = o.env ?? process.env,
    platform = o.platform ?? process.platform,
    parentName = o.parentName ?? (() => processName(process.ppid) ?? "");
  const ldLabel = env[LAUNCHD_ENV] || "";
  const byLaunchd =
    platform === "darwin" &&
    LAUNCHD_LABEL_RE.test(ldLabel) &&
    (o.ppid ?? process.ppid) === 1 &&
    daisyEnv("DAISY_RUNNER_SELF_RESTART", env) !== "0";
  const winName = env[WIN_SUPERVISOR_ENV] || "";
  const byWindows =
    platform === "win32" &&
    WIN_SUPERVISOR_RE.test(winName) &&
    daisyEnv("DAISY_RUNNER_SELF_RESTART", env) !== "0" &&
    (() => {
      try {
        return parentName() === "daisy-win";
      } catch {
        return false;
      }
    })();
  // P5-06 (ADR-145): `daisy start`'s background process (DAISY_RESPAWN=1)
  // starts its successor itself on a restart (daemon.ts) — so an update
  // takes effect without a service manager too (macOS without launchd, a
  // Linux without systemd). Not under Windows' supervisor (P5-05), which
  // starts it again itself.
  const respawn =
    env.DAISY_RESPAWN === "1" &&
    daisyEnv("DAISY_RUNNER_SELF_RESTART", env) !== "0" &&
    !byLaunchd &&
    !byWindows &&
    !env.INVOCATION_ID;
  const supervised =
    o.selfRestart ?? (byLaunchd || byWindows || supervisedBySystemd(env, parentName) || respawn);
  let manager: Supervision["manager"] = "none",
    unit: string | undefined;
  let parent = "";
  if (env.INVOCATION_ID)
    try {
      parent = parentName();
    } catch {}
  if (byLaunchd) {
    manager = "launchd";
    unit = ldLabel;
  } else if (byWindows) {
    manager = "supervise";
    unit = winName;
  } else if (parent === "systemd") {
    manager = "systemd";
    const u = (o.unit ?? ownUnit)();
    if (u && /^[\w.@-]{1,80}$/.test(u)) unit = u;
  } else if (respawn) {
    manager = "respawn";
  } else if (daisyEnv("DAISY_RUNNER_SELF_RESTART", env) === "1") {
    // Another supervisor that starts it again (P6-01: the git-checkout
    // updater's launch.sh and its own LaunchAgent label are gone).
    manager = "supervise";
  }
  const off = o.selfRestart === false || daisyEnv("DAISY_RUNNER_SELF_RESTART", env) === "0";
  return {
    supervised,
    manager,
    ...(unit ? { unit } : {}),
    platform,
    ...(supervised
      ? {}
      : (() => {
          const reasonKey: MessageKey = off ? "server-update.restart.selfRestartOff" : "server-update.restart.notSupervised";
          return { reason: ownerT().dynamic(reasonKey), reasonKey };
        })()),
  };
}

/**
 * The systemd user unit this process runs in, if any (Linux: its cgroup).
 * macOS has no cgroups: the launchd label comes from the plist's
 * DAISY_LAUNCHD_LABEL instead (`supervision`, P5-04).
 */
export function ownUnit(platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== "linux") return null;
  try {
    const cg = readFileSync("/proc/self/cgroup", "utf8");
    return /\/([^/\n]+\.service)\s*$/m.exec(cg)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function restartCapability(s: Supervision): RestartCapability {
  return { version: 2, ...s };
}

/** A restart the caller may not ask for now (the API answers 409). */
export class RestartRefused extends Error {
  constructor(
    /** Why, in a language (the local API says it in the request's). */
    readonly say: (t: Translate) => string,
    /** For `now` without (a current) confirmation: what it would interrupt. */
    readonly interrupts?: BusyItem[],
  ) {
    super(say(ownerT()));
  }
  /** The token that confirms exactly `interrupts` (sent back as `confirm`). */
  get confirm() {
    return this.interrupts ? confirmToken(this.interrupts) : undefined;
  }
}

/**
 * The process's restart state, shared by the local API (asks, shows) and
 * the in-process Runner's loop (knows what runs, carries it out).
 */
export class ProcessRestart {
  private source: {
    busy: () => BusyItem[];
    supervision: Supervision;
  } | null = null;
  private wanted: RestartRequest | null = null;
  /** The last 立即重启 the loop dropped (new work since the confirmation). */
  private dropped: {
    at: number;
    reason: string;
    request: RestartRequest;
    extra: BusyItem[];
  } | null = null;
  private update: PendingUpdate | null = null;
  constructor(private log: (s: string) => void = daisyLog.info) {}
  /** runNode: this process's Runner is up; returns the detach. */
  attach(o: { busy: () => BusyItem[]; supervision: Supervision }) {
    this.source = o;
    return () => {
      if (this.source === o) this.source = null;
    };
  }
  /** What a restart would end right now (empty: idle, or no Runner here). */
  busy(): BusyItem[] {
    try {
      return this.source?.busy() ?? [];
    } catch {
      return [];
    }
  }
  /** The owner's request still to carry out, if any. */
  requested(): RestartRequest | null {
    return this.wanted;
  }
  /**
   * The owner asks. `idle`: once nothing runs (like an update). `now`:
   * interrupts what runs — refused with the list (and a `confirm` token for
   * exactly that list) unless `confirm` is the token of a list that covers
   * everything running now; something new since → refused again, with the
   * new list. Not needed when nothing runs.
   */
  request(
    mode: RestartMode,
    o: { confirm?: string; by?: string } = {},
  ): RestartRequest {
    if (!this.source)
      throw new RestartRefused((t) => t("server-update.restart.noRunner"));
    if (!this.source.supervision.supervised) {
      const sup = this.source.supervision;
      throw new RestartRefused((t) =>
        sup.reasonKey ? t.dynamic(sup.reasonKey) : sup.reason || t("server-update.restart.notSelfStarting"),
      );
    }
    const busy = this.busy();
    const confirmed =
      o.confirm === undefined ? [] : (confirmedKeys(o.confirm) ?? []);
    if (mode === "now" && unconfirmed(busy, confirmed).length)
      throw new RestartRefused(
        (t) =>
          t(o.confirm === undefined ? "server-update.restart.wouldInterrupt" : "server-update.restart.wouldInterruptAgain", {
            busy: describeBusy(busy, t),
          }),
        busy,
      );
    this.dropped = null;
    this.wanted = {
      id: randomUUID(),
      mode,
      at: Date.now(),
      by: o.by,
      ...(mode === "now" ? { confirmed: busy.map(busyKey) } : {}),
    };
    this.log(
      `[restart] restart requested (${mode === "now" ? "now" : "when idle"})${
        busy.length ? `; running now: ${describeBusy(busy, english())}` : ""
      }`,
    );
    return this.wanted;
  }
  /**
   * runNode: a confirmed 立即重启 cannot go — `extra` started after the
   * confirmation. Dropped, and kept for status() until the next request.
   */
  dropNow(r: RestartRequest, extra: BusyItem[]) {
    if (this.wanted?.id !== r.id) return;
    // `reason` in the owner's language; the local API says it again in the request's (droppedReason).
    const reason = droppedReason(extra, ownerT());
    this.dropped = { at: Date.now(), reason, request: r, extra };
    this.wanted = null;
    this.log(`[restart] restart now cancelled: ${describeBusy(extra, english())} started after the confirmation`);
  }
  /** Withdraw the owner's request (not yet carried out). */
  cancel(): boolean {
    const had = !!this.wanted;
    if (had) this.log("[restart] restart request withdrawn");
    this.wanted = null;
    return had;
  }
  /** runNode: the request was carried out (the process is exiting). */
  done(r: RestartRequest) {
    if (this.wanted?.id === r.id) this.wanted = null;
  }
  /** runNode: a release waits for idleness (null: none). */
  setPending(u: Omit<PendingUpdate, "since"> | null) {
    if (!u) this.update = null;
    else if (this.update?.target !== u.target || this.update.kind !== u.kind)
      this.update = { ...u, since: Date.now() };
  }
  /** What the local API shows. */
  status() {
    const busy = this.busy();
    return {
      runner: !!this.source,
      supervision: this.source?.supervision ?? null,
      update: this.update,
      request: this.wanted,
      /** Waiting on these (an update / an idle restart never interrupts them). */
      busy,
      idle: busy.length === 0,
      /** The last 立即重启 dropped for work that started after its confirmation. */
      lastCancelled: this.dropped,
    };
  }
}

/** Why a confirmed restart now was dropped (`extra` started after the confirmation). */
export const droppedReason = (extra: BusyItem[], t: Translate): string =>
  t("server-update.restart.dropped", { busy: describeBusy(extra, t) });

const english = () => translator(shippedPacks(), FALLBACK_LANG);

/** 「2 个会话正在执行的一轮、1 个登录」 (in `t`'s language; default the owner's). */
export function describeBusy(busy: BusyItem[], t: Translate = ownerT()) {
  const sessions = (k: BusyItem["kind"]) =>
    new Set(busy.filter((b) => b.kind === k).map((b) => b.sessionId)).size;
  const count = (k: BusyItem["kind"]) => busy.filter((b) => b.kind === k).length;
  return (
    [
      sessions("turn") && t("server-update.busy.turns", { n: sessions("turn") }),
      sessions("online") && t("server-update.busy.online", { n: sessions("online") }),
      count("background") && t("server-update.busy.background", { n: count("background") }),
      count("login") && t("server-update.busy.logins", { n: count("login") }),
      count("shell") && t("server-update.busy.shells", { n: count("shell") }),
    ]
      .filter(Boolean)
      .join(t("server-update.busy.separator")) || t("server-update.busy.none")
  );
}

/**
 * A Runner's local state (the result journal, a plugin's state) is kept
 * per node.
 */
export function stateKey(nodeId: string) {
  return createHash("sha256")
    .update("daisy|" + nodeId)
    .digest("hex");
}

/**
 * Why work ends when the process goes away under it: the turn's notice in
 * the conversation (R-1: 中断, never replayed — said the same way for a
 * stop, a forced restart and a kill found on the next start).
 */
export class ProcessAbort extends Error {}
/** 立即重启 (also the error of a stopped sign-in / 「在终端执行」 command). */
export class RestartAbort extends ProcessAbort {
  constructor() {
    super(ownerT()("server-update.abort.restart"));
  }
}
/** The process is stopped (SIGTERM / SIGINT) while a turn runs. */
export class StopAbort extends ProcessAbort {
  constructor() {
    super(ownerT()("server-update.abort.stop"));
  }
}
/** A sign-in stopped by 立即重启 (the owner's language). */
export const restartLoginError = (): string => ownerT()("server-update.abort.login");
/** A 「在终端执行」 command stopped by 立即重启 (the owner's language). */
export const restartShellError = (): string => ownerT()("server-update.abort.shell");
/** The signal was aborted by 立即重启. */
export const restartAborted = (signal?: AbortSignal) =>
  !!signal?.aborted && signal.reason instanceof RestartAbort;
