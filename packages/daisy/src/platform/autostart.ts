/**
 * P1-09 (ADR-112 §4): start at boot. Shared by `daisy autostart` (the
 * command line, which works when Daisy is not running) and the routes
 * `settings.autostartStatus` / `autostartSet` (the web page's settings) —
 * one logic, two entry points (原则 6).
 *
 * Linux — a systemd **user** unit (`systemctl
 * --user`, never root, never a system service). `daisy autostart on`
 * writes and enables it; `off` disables and deletes it; `daisy uninstall`
 * does `off` too, so nothing is left to start Daisy again (I-3).
 *
 * macOS (P5-04, ADR-140) — a per-user LaunchAgent (launchd.ts): `on`
 * writes ~/Library/LaunchAgents/<label>.plist (loaded at the owner's next
 * login, started by `daisy start` before that); `off` deletes it.
 *
 * Windows (P5-05, ADR-141) — the current user's Run entry
 * (windows/autostart.ts): `on` writes the value (the helper's `supervise`
 * command line), `off` deletes it. Below, "unit" is the systemd unit, the
 * launchd label or the Run value's name.
 *
 * The unit runs the Daisy process itself (no wrapper): systemd restarts it
 * on a crash and on exit 75 (a restart or an installed update, ADR-104 /
 * ADR-106), stops it with SIGTERM to the main process only (KillMode=mixed:
 * it ends its turns and drains first; what is left is killed after).
 * Port and data directory follow the default rules (ADR-102) — only a
 * data directory chosen explicitly (DAISY_DATA / --data-dir) is written
 * into the unit, and then the unit's name carries a hash of it, so two
 * Daisys of one account never share a unit.
 */
import { pathToFileURL } from "node:url";
import { COMMAND_NAME, PRODUCT_NAME } from "../../../contracts/src/names.ts";
import type { MessageKey, Translate } from "../../../contracts/src/i18n.ts";
import { ownerT } from "./language.ts";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, isAbsolute, join, posix, resolve } from "node:path";
import { dataDir as conventionalDataDir } from "./paths.ts";
import { guiDomain, launchAgentsDir, launchdLabel, parseDisabled, parsePrint, plistFile, plistText, type PlistInput } from "./launchd.ts";
import type { AutostartView } from "../../../contracts/src/api/settings.ts";
import {
  RUN_KEY,
  windowsRunHint,
  WIN_HELPER_CMD,
  parseRunGet,
  runEntry,
  runValueName,
  supervisorLog,
  type SuperviseInput,
} from "./windows/autostart.ts";
import { HelperUnavailable, helperExe } from "./windows/helper.ts";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  /** ENOENT: the program is not installed. */
  missing?: boolean;
}

/** What this module needs of the machine (the command line's Io is one). */
export interface AutostartHost {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  exec(
    cmd: string,
    args: readonly string[],
    opts?: { timeoutMs?: number },
  ): Promise<ExecResult>;
}
type Io = AutostartHost;
/** The machine and the data directory whose Daisy starts at boot. */
type Ctx = { io: AutostartHost; dataDir: string };

/**
 * The service managers a test must never drive for real (the owner's
 * launchd / systemd / Windows Run entry — "daisy-win" is the helper's
 * registry commands, P5-05).
 */
const SERVICE_MANAGERS = new Set(["launchctl", "systemctl", "loginctl", WIN_HELPER_CMD]);
/**
 * P5-04: under `node --test` (NODE_TEST_CONTEXT, set by the test runner for
 * every test file and inherited by a Daisy or a `daisy` a test starts) the
 * real launchctl / systemctl / loginctl are never run: they answer "not
 * installed". Tests that need them pass a fake (autostartHost, testIo).
 */
export const blockedUnderTest = (cmd: string): ExecResult | null =>
  process.env.NODE_TEST_CONTEXT && SERVICE_MANAGERS.has(cmd)
    ? { code: 127, stdout: "", stderr: "", missing: true }
    : null;

/** This process's machine (the server's routes; never throws). */
export function processHost(): AutostartHost {
  return {
    env: process.env,
    platform: process.platform,
    exec: (cmd, args, opts = {}) =>
      blockedUnderTest(cmd)
        ? Promise.resolve(blockedUnderTest(cmd)!)
        : cmd === WIN_HELPER_CMD && !winHelper()
          ? Promise.resolve({ code: 127, stdout: "", stderr: "", missing: true })
        : new Promise((done) =>
        execFile(
          cmd === WIN_HELPER_CMD ? winHelper()! : cmd,
          [...args],
          { timeout: opts.timeoutMs ?? 15_000, encoding: "utf8" },
          (e: any, stdout, stderr) =>
            done(
              e?.code === "ENOENT"
                ? { code: 127, stdout: "", stderr: "", missing: true }
                : { code: e ? (typeof e.code === "number" ? e.code : 1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") },
            ),
        ),
      ),
  };
}

/** The compiled Windows helper, or null (not Windows, cannot compile). */
export function winHelper(): string | null {
  if (process.platform !== "win32") return null;
  try {
    return helperExe();
  } catch (e) {
    if (e instanceof HelperUnavailable) return null;
    throw e;
  }
}

/**
 * What went wrong with autostart, as message keys: `key` (what) and
 * `fixKey` (what to do), their params, and the failed command's first
 * line of stderr or exit code (`detail`, said by `sayAutostart`).
 */
export interface AutostartMsg {
  key: MessageKey;
  fixKey: MessageKey;
  params?: Record<string, string | number>;
  /** A failed command: its stderr's first line, or its exit code. */
  failed?: { stderr: string; code: number | null };
}

/** An `AutostartMsg` in a language: `why` and `fix`. */
export function sayAutostart(m: AutostartMsg, t: Translate = ownerT()): { why: string; fix: string } {
  const detail = m.failed ? m.failed.stderr || t("server-platform.exitCode", { code: String(m.failed.code) }) : "";
  const params = { ...m.params, detail };
  return { why: t.dynamic(m.key, params), fix: t.dynamic(m.fixKey, params) };
}

/** A failure with what to do about it (the command line prints both; `message` / `fix` in the owner's language). */
export class AutostartError extends Error {
  public fix: string;
  constructor(public msg: AutostartMsg) {
    const said = sayAutostart(msg);
    super(said.why);
    this.fix = said.fix;
  }
}

/** The repository / package root, and the Daisy process's entry. */
export const CODE_ROOT = resolve(import.meta.dirname, "../../../..");
export const SERVER_MAIN = join(import.meta.dirname, "..", "main.ts");

/** Preloaded first: drops only Node's SQLite ExperimentalWarning (quiet-warnings.mjs). */
export const QUIET_WARNINGS = join(import.meta.dirname, "quiet-warnings.mjs");
/** The command that runs the Daisy process in the foreground (`node --import <quiet> --import <tsx> main.ts`). */
export function serverCommand(): { node: string; args: string[]; cwd: string } {
  return {
    node: process.execPath,
    args: [
      "--import",
      pathToFileURL(QUIET_WARNINGS).href,
      "--import",
      import.meta.resolve("tsx"),
      SERVER_MAIN,
    ],
    cwd: CODE_ROOT,
  };
}

/** Whether `dataDir` is the default one (no DAISY_DATA / HARBOR_DATA). */
export function isDefaultDataDir(dataDir: string, env: Io["env"], platform: NodeJS.Platform): boolean {
  const dflt = conventionalDataDir(
    { ...env, DAISY_DATA: undefined, HARBOR_DATA: undefined },
    platform,
    env.HOME || homedir(),
  );
  return resolve(dataDir) === resolve(dflt);
}

export function unitName(dataDir: string, env: Io["env"], platform: NodeJS.Platform = "linux"): string {
  if (isDefaultDataDir(dataDir, env, platform)) return `${COMMAND_NAME}.service`;
  const h = createHash("sha256").update(resolve(dataDir)).digest("hex").slice(0, 8);
  return `${COMMAND_NAME}-${h}.service`;
}

/** Where systemd looks for this account's own units. */
export function unitDir(env: Io["env"]): string {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && isAbsolute(xdg) ? xdg : join(env.HOME || homedir(), ".config");
  return join(base, "systemd", "user");
}

export const unitFile = (dataDir: string, env: Io["env"]) => join(unitDir(env), unitName(dataDir, env));

/** A word of ExecStart= / Environment=: quoted, `%` and `$` escaped. */
export function sdQuote(s: string): string {
  if (/[\x00-\x1f]/.test(s)) throw new Error(ownerT()("server-platform.path.controlCharUnit"));
  const esc = s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$");
  return /[\s"'\\;]/.test(s) || esc !== s ? `"${esc}"` : s;
}

/**
 * The PATH the service gets: the one `autostart on` ran with (absolute
 * entries only), so the harness CLIs the owner installed (claude, codex,
 * kimi — often in ~/.local/bin or an nvm directory) are found at boot.
 */
export function servicePath(env: Io["env"], node = process.execPath): string {
  // A systemd unit: POSIX paths, `:`-separated, whatever this host is.
  const parts = (env.PATH ?? "").split(":").filter((p) => p && posix.isAbsolute(p));
  const nodeDir = posix.dirname(node);
  if (!parts.includes(nodeDir)) parts.unshift(nodeDir);
  for (const p of ["/usr/local/bin", "/usr/bin", "/bin"]) if (!parts.includes(p)) parts.push(p);
  return [...new Set(parts)].join(":");
}

export interface UnitInput {
  dataDir: string;
  /** Write DAISY_DATA (an explicitly chosen data directory). */
  explicitDataDir: boolean;
  node: string;
  args: string[];
  cwd: string;
  path: string;
}

export function unitText(u: UnitInput): string {
  const lines = [
    `# Written by \`${COMMAND_NAME} autostart on\`. \`${COMMAND_NAME} autostart off\` or`,
    `# \`${COMMAND_NAME} uninstall\` disables and deletes it. Edits are overwritten by the next \`on\`.`,
    "[Unit]",
    `Description=${PRODUCT_NAME} — your AI on this machine`,
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${sdQuote(u.cwd)}`,
    `ExecStart=${[u.node, ...u.args].map(sdQuote).join(" ")}`,
    `Environment=${sdQuote("PATH=" + u.path)}`,
    ...(u.explicitDataDir ? [`Environment=${sdQuote("DAISY_DATA=" + u.dataDir)}`] : []),
    "# Exit 75: restart for an update or the owner's restart (ADR-104).",
    "Restart=on-failure",
    "RestartForceExitStatus=75",
    "RestartSec=3",
    `# SIGTERM to ${PRODUCT_NAME} only: it ends running turns (not replayed) and drains;`,
    "# whatever is left in the group is killed after it exits.",
    "KillMode=mixed",
    "TimeoutStopSec=45",
    "UMask=0077",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ];
  return lines.join("\n");
}

export function unitInputFor(ctx: Ctx): UnitInput {
  const c = serverCommand();
  return {
    dataDir: resolve(ctx.dataDir),
    explicitDataDir: !isDefaultDataDir(ctx.dataDir, ctx.io.env, "linux"),
    node: c.node,
    args: c.args,
    cwd: c.cwd,
    path: servicePath(ctx.io.env, c.node),
  };
}

export function plistInputFor(ctx: Ctx): PlistInput {
  const c = serverCommand();
  const isDefault = isDefaultDataDir(ctx.dataDir, ctx.io.env, "darwin");
  return {
    label: launchdLabel(ctx.dataDir, isDefault),
    dataDir: resolve(ctx.dataDir),
    explicitDataDir: !isDefault,
    node: c.node,
    args: c.args,
    cwd: c.cwd,
    path: servicePath(ctx.io.env, c.node),
    log: join(resolve(ctx.dataDir), "logs", `${COMMAND_NAME}.log`),
  };
}

/** Windows: the helper's `supervise` for this data directory (`helper`: its path). */
export function superviseInputFor(ctx: Ctx, helper: string, once = false): SuperviseInput {
  const c = serverCommand();
  const isDefault = isDefaultDataDir(ctx.dataDir, ctx.io.env, "win32");
  return {
    helper,
    name: runValueName(ctx.dataDir, isDefault),
    log: supervisorLog(ctx.dataDir),
    cwd: c.cwd,
    node: c.node,
    args: c.args,
    dataDir: resolve(ctx.dataDir),
    explicitDataDir: !isDefault,
    once,
  };
}

/** The Run value's name of this data directory's Daisy. */
export const runNameFor = (ctx: Ctx) => runValueName(ctx.dataDir, isDefaultDataDir(ctx.dataDir, ctx.io.env, "win32"));

/** The launchd label of this data directory's Daisy. */
export const labelFor = (ctx: Ctx) => launchdLabel(ctx.dataDir, isDefaultDataDir(ctx.dataDir, ctx.io.env, "darwin"));

// ── launchctl (macOS) ───────────────────────────────────────────────────

export const launchctl = (io: Io, ...args: string[]) => io.exec("launchctl", args, { timeoutMs: 60_000 });

// ── systemctl ───────────────────────────────────────────────────────────

export const systemctl = (io: Io, ...args: string[]) =>
  io.exec("systemctl", ["--user", ...args], { timeoutMs: 60_000 });

export type Support = { ok: true } | ({ ok: false; why: string; fix: string } & { msg: AutostartMsg });

const unsupported = (msg: AutostartMsg, t: Translate): Support => ({ ok: false, ...sayAutostart(msg, t), msg });

/** Whether this machine and session can have a user unit (`why` / `fix` in `t`'s language). */
export async function autostartSupport(io: Io, t: Translate = ownerT()): Promise<Support> {
  if (io.platform === "darwin") {
    // Only that launchctl is there: the plist takes effect at the next
    // login even when no one is logged in to the GUI now (an ssh session).
    const r = await launchctl(io, "print", guiDomain());
    if (r.missing)
      return unsupported({ key: "server-platform.autostart.noLaunchctl", fixKey: "server-platform.autostart.fixManualOrManager" }, t);
    return { ok: true };
  }
  if (io.platform === "win32") {
    // The Run entry runs the helper: it must be there (compiled by the
    // C# compiler Windows ships).
    const r = await io.exec(WIN_HELPER_CMD, ["path"]);
    if (r.missing || r.code !== 0 || !r.stdout.trim())
      return unsupported(
        r.stderr
          ? { key: "server-platform.autostart.noHelperWhy", fixKey: "server-platform.autostart.fixDoctorManual", params: { why: firstLine(r.stderr) } }
          : { key: "server-platform.autostart.noHelper", fixKey: "server-platform.autostart.fixDoctorManual" },
        t,
      );
    return { ok: true };
  }
  if (io.platform !== "linux")
    return unsupported({ key: "server-platform.autostart.platformUnsupported", fixKey: "server-platform.autostart.fixManual", params: { platform: io.platform } }, t);
  const r = await systemctl(io, "show-environment");
  if (r.missing)
    return unsupported({ key: "server-platform.autostart.noSystemctl", fixKey: "server-platform.autostart.fixSystemdOnly" }, t);
  if (r.code !== 0)
    return unsupported(
      {
        key: "server-platform.autostart.noUserManager",
        fixKey: "server-platform.autostart.fixUserSession",
        failed: { stderr: firstLine(r.stderr), code: r.code },
      },
      t,
    );
  return { ok: true };
}

const firstLine = (s: string) => s.trim().split("\n")[0]?.slice(0, 200) ?? "";

export interface AutostartState {
  /** Who starts it: a systemd user unit (Linux), a LaunchAgent (macOS), the Run entry (Windows). */
  manager: "systemd" | "launchd" | "windows-run";
  /** The systemd unit name, or the launchd label. */
  unit: string;
  /** The unit file, or the plist. */
  file: string;
  /** The unit file exists. */
  installed: boolean;
  /** `systemctl --user is-enabled` says enabled; launchd: the plist is there and not disabled. */
  enabled: boolean;
  /** The unit runs now. */
  active: boolean;
  /** launchd: the job is loaded in the GUI domain now (running or not); systemd: = active. */
  loaded: boolean;
  /** Its main process id while active. */
  mainPid: number | null;
  /** loginctl's Linger: starts at boot without logging in. */
  linger: boolean | null;
  /** Windows: the Run value (the command line it starts). */
  value?: string | null;
}

export async function autostartState(ctx: Ctx): Promise<AutostartState> {
  if (ctx.io.platform === "darwin") return launchdState(ctx);
  if (ctx.io.platform === "win32") return windowsRunState(ctx);
  const unit = unitName(ctx.dataDir, ctx.io.env);
  const file = join(unitDir(ctx.io.env), unit);
  const installed = existsSync(file);
  const s: AutostartState = { manager: "systemd", unit, file, installed, enabled: false, active: false, loaded: false, mainPid: null, linger: null };
  if (ctx.io.platform !== "linux") return s;
  const en = await systemctl(ctx.io, "is-enabled", unit);
  if (en.missing) return s;
  s.enabled = en.stdout.trim() === "enabled";
  const ac = await systemctl(ctx.io, "is-active", unit);
  s.active = ac.stdout.trim() === "active" || ac.stdout.trim() === "activating" || ac.stdout.trim() === "reloading";
  s.loaded = s.active;
  if (s.active) {
    const pid = await systemctl(ctx.io, "show", "-p", "MainPID", "--value", unit);
    const n = Number(pid.stdout.trim());
    s.mainPid = Number.isInteger(n) && n > 0 ? n : null;
  }
  s.linger = await linger(ctx.io);
  return s;
}

/** macOS: the plist, the disabled overrides and the job as launchd has it now. */
async function launchdState(ctx: Ctx): Promise<AutostartState> {
  const unit = labelFor(ctx);
  const file = plistFile(ctx.io.env, unit);
  const installed = existsSync(file);
  const s: AutostartState = { manager: "launchd", unit, file, installed, enabled: false, active: false, loaded: false, mainPid: null, linger: null };
  const dis = await launchctl(ctx.io, "print-disabled", guiDomain());
  if (dis.missing) return s;
  s.enabled = installed && !(dis.code === 0 && parseDisabled(dis.stdout, unit));
  const pr = await launchctl(ctx.io, "print", `${guiDomain()}/${unit}`);
  if (pr.code === 0) {
    s.loaded = true;
    const p = parsePrint(pr.stdout);
    s.active = p.running;
    s.mainPid = p.running ? p.pid : null;
  }
  return s;
}

/** Windows: the Run value (its name, whether it is there, what it runs). */
async function windowsRunState(ctx: Ctx): Promise<AutostartState> {
  const unit = runNameFor(ctx);
  const r = await ctx.io.exec(WIN_HELPER_CMD, ["run-get", unit]);
  const value = r.code === 0 && !r.missing ? parseRunGet(r.stdout) : null;
  return {
    manager: "windows-run",
    unit,
    file: `${RUN_KEY}\\${unit}`,
    installed: !!value,
    enabled: !!value,
    active: false,
    loaded: false,
    mainPid: null,
    linger: null,
    value,
  };
}

/** Windows `autostart on`: write the Run value (the helper's `supervise`). Never starts it. */
async function windowsRunOn(ctx: Ctx): Promise<AutostartState> {
  const p = await ctx.io.exec(WIN_HELPER_CMD, ["path"]);
  const helper = p.stdout.trim();
  const input = superviseInputFor(ctx, helper);
  mkdirSync(dirname(input.log), { recursive: true, mode: 0o700 });
  const value = runEntry(input);
  const now = await windowsRunState(ctx);
  if (now.value !== value) {
    const r = await ctx.io.exec(WIN_HELPER_CMD, ["run-set", input.name, value]);
    if (r.code !== 0)
      throw new AutostartError({
        key: "server-platform.autostart.runSetFailed",
        fixKey: "server-platform.autostart.fixDoctorRetry",
        params: { entry: `${RUN_KEY}\\${input.name}` },
        failed: { stderr: firstLine(r.stderr), code: r.code },
      });
  }
  return windowsRunState(ctx);
}

export async function linger(io: Io): Promise<boolean | null> {
  let user: string;
  try {
    user = userInfo().username;
  } catch {
    return null;
  }
  const r = await io.exec("loginctl", ["show-user", user, "--property=Linger", "--value"]);
  if (r.missing || r.code !== 0) return null;
  return r.stdout.trim() === "yes";
}

/** macOS: what "start at login" means there. */
export const launchdHint = (t: Translate = ownerT()): string => t("server-platform.autostart.launchdHint");

export function lingerHint(t: Translate = ownerT()): string {
  let user = "$USER";
  try {
    user = userInfo().username;
  } catch {}
  return t("server-platform.autostart.lingerHint", { user });
}

async function must(io: Io, what: MessageKey, ...args: string[]) {
  const r = await systemctl(io, ...args);
  if (r.code !== 0)
    throw new AutostartError({
      key: what,
      fixKey: "server-platform.autostart.fixSystemctlStatus",
      params: { args: args.join(" ") },
      failed: { stderr: firstLine(r.stderr), code: r.code },
    });
  return r;
}

/** `daisy autostart on`: write, reload, enable. Idempotent. */
export async function autostartOn(ctx: Ctx): Promise<AutostartState> {
  const sup = await autostartSupport(ctx.io);
  if (!sup.ok) throw new AutostartError(sup.msg);
  if (ctx.io.platform === "darwin") return launchdOn(ctx);
  if (ctx.io.platform === "win32") return windowsRunOn(ctx);
  const unit = unitName(ctx.dataDir, ctx.io.env);
  const dir = unitDir(ctx.io.env);
  const file = join(dir, unit);
  mkdirSync(dir, { recursive: true });
  const text = unitText(unitInputFor(ctx));
  const before = existsSync(file) ? readFileSync(file, "utf8") : null;
  if (before !== text) writeFileSync(file, text, { mode: 0o644 });
  await must(ctx.io, "server-platform.autostart.reloadFailed", "daemon-reload");
  await must(ctx.io, "server-platform.autostart.enableFailed", "enable", unit);
  return autostartState(ctx);
}

/** macOS `autostart on`: write the plist (0644), clear a disabled override. Never starts it. */
async function launchdOn(ctx: Ctx): Promise<AutostartState> {
  const input = plistInputFor(ctx);
  const dir = launchAgentsDir(ctx.io.env);
  const file = plistFile(ctx.io.env, input.label);
  mkdirSync(dir, { recursive: true });
  // The log launchd appends to: in the private logs folder, 0600 (launchd
  // would create it 0644).
  mkdirSync(dirname(input.log), { recursive: true, mode: 0o700 });
  try {
    if (!existsSync(input.log)) writeFileSync(input.log, "", { mode: 0o600, flag: "wx" });
    chmodSync(input.log, 0o600);
  } catch {}
  const text = plistText(input);
  const before = existsSync(file) ? readFileSync(file, "utf8") : null;
  if (before !== text) writeFileSync(file, text, { mode: 0o644 });
  chmodSync(file, 0o644);
  const now = await launchdState(ctx);
  // Loaded from an older plist and not running: unload it, so the next
  // `daisy start` (or login) loads the plist just written.
  if (now.loaded && !now.active && before !== text) await launchctl(ctx.io, "bootout", `${guiDomain()}/${input.label}`);
  const r = await launchctl(ctx.io, "enable", `${guiDomain()}/${input.label}`);
  if (r.code !== 0)
    throw new AutostartError({
      key: "server-platform.autostart.launchdEnableFailed",
      fixKey: "server-platform.autostart.fixLaunchctlPrint",
      params: { target: `${guiDomain()}/${input.label}` },
      failed: { stderr: firstLine(r.stderr), code: r.code },
    });
  return launchdState(ctx);
}

/**
 * `daisy autostart off`: disable, delete, reload. A Daisy the unit runs
 * now keeps running (stopping is `daisy stop`'s); it will not start at
 * the next boot. Returns whether there was anything to remove.
 */
export async function autostartOff(ctx: Ctx): Promise<boolean> {
  if (ctx.io.platform === "darwin") {
    // Delete the plist: launchd will not load it at the next login. A job
    // loaded now keeps running (stopping is `daisy stop`'s, which unloads
    // it); one loaded but not running is unloaded here.
    const st = await launchdState(ctx);
    rmSync(st.file, { force: true });
    if (st.loaded && !st.active) await launchctl(ctx.io, "bootout", `${guiDomain()}/${st.unit}`);
    return st.installed;
  }
  if (ctx.io.platform === "win32") {
    // Delete the value: nothing starts Daisy at the next login. A Daisy it
    // started keeps running until `daisy stop`.
    const r = await ctx.io.exec(WIN_HELPER_CMD, ["run-delete", runNameFor(ctx)]);
    if (r.code !== 0 && !r.missing)
      throw new AutostartError({
        key: "server-platform.autostart.runDeleteFailed",
        fixKey: "server-platform.autostart.fixDoctorRetry",
        params: { entry: `${RUN_KEY}\\${runNameFor(ctx)}` },
        failed: { stderr: firstLine(r.stderr), code: r.code },
      });
    return /deleted/.test(r.stdout);
  }
  const unit = unitName(ctx.dataDir, ctx.io.env);
  const file = join(unitDir(ctx.io.env), unit);
  const had = existsSync(file);
  if (ctx.io.platform !== "linux") return had;
  const r = await systemctl(ctx.io, "disable", unit);
  if (r.missing) {
    if (had) rmSync(file, { force: true });
    return had;
  }
  // The links `enable` made are gone now; the file goes next.
  rmSync(file, { force: true });
  await systemctl(ctx.io, "daemon-reload");
  return had || r.code === 0 && /Removed/.test(r.stderr + r.stdout);
}

// ── the web page's view (settings.autostartStatus / autostartSet) ────────

export type { AutostartView };

export async function autostartView(ctx: Ctx, t: Translate = ownerT()): Promise<AutostartView> {
  const sup = await autostartSupport(ctx.io, t);
  if (!sup.ok) return { supported: false, enabled: false, manager: null, reason: sup.why };
  const st = await autostartState(ctx);
  const enabled = st.installed && st.enabled;
  if (st.manager === "windows-run")
    return {
      supported: true,
      enabled,
      manager: "windows-run",
      unit: st.unit,
      ...(enabled ? { hint: windowsRunHint(t) } : {}),
    };
  if (st.manager === "launchd")
    return {
      supported: true,
      enabled,
      manager: "launchd",
      unit: st.unit,
      ...(enabled ? { hint: launchdHint(t) } : {}),
    };
  return {
    supported: true,
    enabled,
    manager: "systemd-user",
    unit: st.unit,
    linger: st.linger,
    ...(enabled && st.linger === false ? { hint: lingerHint(t) } : {}),
  };
}

/** Turn it on or off; unsupported systems answer with the view (supported: false). */
export async function setAutostart(ctx: Ctx, enabled: boolean, t: Translate = ownerT()): Promise<AutostartView> {
  const sup = await autostartSupport(ctx.io, t);
  if (!sup.ok) return { supported: false, enabled: false, manager: null, reason: sup.why };
  if (enabled) await autostartOn(ctx);
  else await autostartOff(ctx);
  return autostartView(ctx, t);
}
