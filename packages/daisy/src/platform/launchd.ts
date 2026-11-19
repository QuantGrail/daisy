/**
 * P5-04 (ADR-140): start at login on macOS — a per-user LaunchAgent, the
 * macOS counterpart of the systemd user unit (autostart.ts). No root, no
 * system daemon: the plist lives in ~/Library/LaunchAgents and is loaded
 * into the owner's GUI domain (`gui/<uid>`) by launchd when they log in.
 *
 * Why launchd and not a detached process (C-1 device acceptance N-9): a
 * process started from a restricted or sandboxed shell cannot read the
 * login keychain, so Claude's subscription sign-in looks expired; launchd
 * starts Daisy in the owner's own login session, where it can.
 *
 * The job runs the Daisy process itself (no wrapper), like the unit:
 * - RunAtLoad: started when loaded (at login, or by `daisy start`);
 * - KeepAlive { SuccessfulExit: false }: started again after a crash or a
 *   non-zero exit — 75 is a restart for an update or the owner's restart
 *   (ADR-104 / ADR-106); a stop (SIGTERM → exit 0) stays stopped;
 * - ExitTimeOut 45: SIGTERM, then 45 s to end its turns and drain before
 *   SIGKILL (the unit's TimeoutStopSec);
 * - Umask 077, stdout / stderr appended to <data>/logs/daisy.log (the same
 *   file a background process writes);
 * - DAISY_LAUNCHD_LABEL tells the process launchd supervises it
 *   (update/restart.ts; launchd's own XPC_SERVICE_NAME reads "0" in the
 *   process on current macOS, measured).
 *
 * `daisy start` with the plist installed: `launchctl bootstrap gui/<uid>`
 * (or `kickstart` when already loaded); `daisy stop`: `launchctl bootout`
 * (unloads it: it stays stopped until the next `daisy start` or login).
 */
import { ownerT } from "./language.ts";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { COMMAND_NAME, PRODUCT_NAME } from "../../../contracts/src/names.ts";

/** The default data directory's label; another one gets `-<hash>`. */
export const LAUNCHD_LABEL = `ai.${COMMAND_NAME}.${COMMAND_NAME}`;
export const LAUNCHD_LABEL_RE = new RegExp(`^ai\\.${COMMAND_NAME}\\.${COMMAND_NAME}(-[0-9a-f]{8})?$`);
/** The environment variable the plist sets (update/restart.ts reads it). */
export const LAUNCHD_ENV = "DAISY_LAUNCHD_LABEL";

export function launchdLabel(dataDir: string, isDefault: boolean): string {
  if (isDefault) return LAUNCHD_LABEL;
  return `${LAUNCHD_LABEL}-${createHash("sha256").update(resolve(dataDir)).digest("hex").slice(0, 8)}`;
}

/** Where launchd looks for this account's own agents. */
export const launchAgentsDir = (env: Record<string, string | undefined>) =>
  join(env.HOME || homedir(), "Library", "LaunchAgents");

export const plistFile = (env: Record<string, string | undefined>, label: string) =>
  join(launchAgentsDir(env), `${label}.plist`);

/** This account's GUI domain (`gui/501`). */
export const guiDomain = (uid: number = process.getuid?.() ?? 0) => `gui/${uid}`;

/** A plist string: XML-escaped; control characters refused. */
export function plistString(s: string): string {
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(s) || /[\n\r\t]/.test(s))
    throw new Error(ownerT()("server-platform.path.controlCharPlist"));
  return `<string>${s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</string>`;
}

export interface PlistInput {
  label: string;
  dataDir: string;
  /** Write DAISY_DATA (an explicitly chosen data directory). */
  explicitDataDir: boolean;
  node: string;
  args: string[];
  cwd: string;
  path: string;
  /** <data>/logs/daisy.log */
  log: string;
}

export function plistText(p: PlistInput): string {
  const env: [string, string][] = [
    ["PATH", p.path],
    [LAUNCHD_ENV, p.label],
    ...(p.explicitDataDir ? ([["DAISY_DATA", p.dataDir]] as [string, string][]) : []),
  ];
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<!-- Written by \`${COMMAND_NAME} autostart on\`. \`${COMMAND_NAME} autostart off\` or`,
    `     \`${COMMAND_NAME} uninstall\` deletes it. Edits are overwritten by the next \`on\`. -->`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  ${plistString(p.label)}`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    ...[p.node, ...p.args].map((a) => `    ${plistString(a)}`),
    `  </array>`,
    `  <key>WorkingDirectory</key>`,
    `  ${plistString(p.cwd)}`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    ...env.flatMap(([k, v]) => [`    <key>${k}</key>`, `    ${plistString(v)}`]),
    `  </dict>`,
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    `  <!-- A crash or a non-zero exit (75: a restart for an update, ADR-104) starts it again; a stop does not. -->`,
    `  <key>KeepAlive</key>`,
    `  <dict>`,
    `    <key>SuccessfulExit</key>`,
    `    <false/>`,
    `  </dict>`,
    `  <key>ThrottleInterval</key>`,
    `  <integer>10</integer>`,
    `  <!-- SIGTERM to ${PRODUCT_NAME}: it ends running turns (not replayed) and drains. -->`,
    `  <key>ExitTimeOut</key>`,
    `  <integer>45</integer>`,
    `  <key>ProcessType</key>`,
    `  <string>Standard</string>`,
    `  <key>Umask</key>`,
    `  <integer>63</integer>`,
    `  <key>StandardOutPath</key>`,
    `  ${plistString(p.log)}`,
    `  <key>StandardErrorPath</key>`,
    `  ${plistString(p.log)}`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
}

/** `launchctl print gui/<uid>/<label>`: loaded, running, its pid. */
export function parsePrint(stdout: string): { running: boolean; pid: number | null } {
  const state = /^\s*state = (.+)$/m.exec(stdout)?.[1]?.trim();
  const pid = Number(/^\s*pid = (\d+)\s*$/m.exec(stdout)?.[1]);
  const p = Number.isInteger(pid) && pid > 0 ? pid : null;
  return { running: state === "running" || (state === undefined && p !== null), pid: p };
}

/** `launchctl print-disabled gui/<uid>`: is `label` disabled (an override)? */
export function parseDisabled(stdout: string, label: string): boolean {
  const esc = label.replace(/\./g, "\\.");
  return new RegExp(`"${esc}"\\s*=>\\s*(disabled|true)\\b`).test(stdout);
}
