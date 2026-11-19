/**
 * P5-05 (ADR-141): start at login on Windows — the current user's Run entry
 * (HKCU\Software\Microsoft\Windows\CurrentVersion\Run), the Windows
 * counterpart of the systemd user unit and the LaunchAgent. No
 * administrator: the key is the account's own. Windows starts what it names
 * when the owner logs in; it shows in Task Manager → Startup apps, where it
 * can also be turned off.
 *
 * The entry runs Daisy's helper (`daisy-win supervise`, GUI subsystem: no
 * console window), which runs the Daisy process itself in a Job Object with
 * its output appended to <data>\logs\daisy.log, and starts it again after
 * exit 75 (an update or the owner's restart) or a crash; `daisy stop`
 * (exit 0) stays stopped. `daisy start` with the entry present starts the
 * same command; without it, the same helper with --once (nothing restarts it).
 *
 * Why not a Scheduled Task: a logon-triggered task needs administrator
 * rights from `schtasks /create /sc onlogon`, its defaults stop it on
 * battery and after 72 hours, and it still needs a windowless launcher — the
 * Run entry needs none of that (ADR-141).
 *
 * The registry is read and written through the helper (`run-get`,
 * `run-set`, `run-delete`) behind the command name "daisy-win" on the
 * AutostartHost — so tests fake it, and under `node --test` the real one is
 * never touched (autostart.ts `blockedUnderTest`).
 */
import type { Translate } from "../../../../contracts/src/i18n.ts";
import { ownerT } from "../language.ts";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { COMMAND_NAME, PRODUCT_NAME } from "../../../../contracts/src/names.ts";
import { commandLine } from "./cmdline.ts";

/** The command name autostart.ts routes to the helper. */
export const WIN_HELPER_CMD = "daisy-win";
export const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
/** The environment variable the helper's `supervise` sets (update/restart.ts reads it). */
export const WIN_SUPERVISOR_ENV = "DAISY_WIN_SUPERVISOR";
export const WIN_SUPERVISOR_RE = new RegExp(`^${PRODUCT_NAME}(-[0-9a-f]{8})?$`);

/** The default data directory's entry is "Daisy"; another one gets `-<hash>` (like the unit / label). */
export function runValueName(dataDir: string, isDefault: boolean): string {
  if (isDefault) return PRODUCT_NAME;
  return `${PRODUCT_NAME}-${createHash("sha256").update(resolve(dataDir)).digest("hex").slice(0, 8)}`;
}

export interface SuperviseInput {
  /** The compiled helper (daisy-win.exe). */
  helper: string;
  name: string;
  log: string;
  cwd: string;
  node: string;
  args: string[];
  dataDir: string;
  explicitDataDir: boolean;
  /** Never start it again (daisy start without start at login). */
  once?: boolean;
}

/** The helper's `supervise` arguments (after the helper itself). */
export function superviseArgs(i: SuperviseInput): string[] {
  return [
    "supervise",
    "--name",
    i.name,
    "--log",
    i.log,
    "--cwd",
    i.cwd,
    ...(i.explicitDataDir ? ["--set", `DAISY_DATA=${i.dataDir}`] : []),
    ...(i.once ? ["--once"] : []),
    "--app",
    i.node,
    "--cmdline",
    commandLine([i.node, ...i.args]),
  ];
}

/** The Run entry's value: one command line, no shell. */
export function runEntry(i: SuperviseInput): string {
  const line = commandLine([i.helper, ...superviseArgs(i)]);
  if (/[\r\n]/.test(line)) throw new Error(ownerT()("server-platform.path.lineBreakRunEntry"));
  return line;
}

/** `run-get`'s answer: the value, or null when there is none. */
export const parseRunGet = (stdout: string): string | null => stdout.replace(/\r?\n$/, "") || null;

/** What start at login means on Windows (the settings page and `daisy autostart on`). */
export const windowsRunHint = (t: Translate = ownerT()): string => t("server-platform.autostart.windowsHint", { key: RUN_KEY });

/** The log the supervisor appends to. */
export const supervisorLog = (dataDir: string) => join(resolve(dataDir), "logs", `${COMMAND_NAME}.log`);
