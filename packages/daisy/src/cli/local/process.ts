/**
 * P1-07: `daisy start` / `daisy stop` — the Daisy process itself.
 *
 * How it runs (ADR-112 §2):
 * - with start at boot on (a systemd user unit, `daisy autostart on`):
 *   `systemctl --user start|stop <unit>`. systemd supervises it, so a
 *   restart (exit 75: an installed update, `daisy restart request`) and a
 *   crash bring it back.
 * - macOS with start at login on (a LaunchAgent, P5-04 / ADR-140):
 *   `launchctl bootstrap gui/<uid> <plist>` (`kickstart` when loaded) and
 *   `launchctl bootout`. launchd supervises it the same way, and it runs
 *   in the owner's login session — where the keychain is readable (N-9).
 * - otherwise: one detached process, `node --import tsx main.ts`, output
 *   appended to `<data>/logs/daisy.log`. Nothing supervises it; P5-06: on a
 *   restart (an update, the owner's request) it starts its successor
 *   itself (DAISY_RESPAWN=1, restart.ts `respawn`).
 * - Windows (P5-05, ADR-141): Daisy's helper `supervise` runs it — no
 *   console window, output to the log, in a Job Object; it starts Daisy
 *   again after exit 75 (an update, the owner's restart) or a crash. With
 *   start at login on (the HKCU Run entry) the same command the entry holds.
 * - `daisy start --foreground`: in this terminal, for debugging or for a
 *   service manager other than systemd.
 *
 * Stopping is SIGTERM (Windows: a stop request file, platform/windows/stop.ts —
 * there is no SIGTERM there): the process ends running turns (marked 中断, not
 * replayed — 原则 2), drains HTTP and removes its runtime file.
 */
import { envNames } from "../../../../contracts/src/env.ts";
import { withoutFileSettings } from "../../platform/settings.ts";
import { spawn } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { CliError, usageError } from "../errors.ts";
import { Daisy, health, locate, logFile, logsDir, pidAlive, type Ctx, type Runtime } from "../daisy.ts";
import { serverCommand, SERVER_MAIN } from "../code.ts";
import { callRoute, ROUTES } from "../routes.ts";
import { autostartState, launchctl, superviseInputFor, systemctl, winHelper, type AutostartState } from "../../platform/autostart.ts";
import { runEntry, superviseArgs, WIN_HELPER_CMD } from "../../platform/windows/autostart.ts";
import { requestStop } from "../../platform/windows/stop.ts";
import { guiDomain } from "../../platform/launchd.ts";
import { t } from "../lang.ts";

const START_TIMEOUT_MS = 90_000;
/** The process's own budget: turns 20 s + drain 5 s, and some margin. */
const STOP_TIMEOUT_MS = 60_000;
const LOG_ROTATE_BYTES = 10 * 1024 * 1024;

/** Running and answering: the runtime file's process is up and serves health. */
export async function runningDaisy(ctx: Ctx): Promise<Runtime | null> {
  const f = locate(ctx.dataDir);
  if (f.state !== "running") return null;
  return (await health(f.rt.local.url)) ? f.rt : null;
}

/** Wait until a Daisy of this data directory answers (started at or after `since`). */
export async function waitUntilUp(
  ctx: Ctx,
  o: { since: number; pid?: number; exited?: () => number | null; timeoutMs?: number },
): Promise<Runtime> {
  const until = Date.now() + (o.timeoutMs ?? START_TIMEOUT_MS);
  while (Date.now() < until) {
    const code = o.exited?.();
    if (code !== null && code !== undefined)
      throw new CliError(
        t("cli.process.exited", { code, tail: tailOfLog(ctx.dataDir) }),
        t("cli.process.exitedFix", { log: logFile(ctx.dataDir) }),
      );
    const f = locate(ctx.dataDir);
    if (
      f.state === "running" &&
      (o.pid === undefined || f.rt.pid === o.pid) &&
      f.rt.startedAt >= o.since - 2000 &&
      (await health(f.rt.local.url, 2000))
    )
      return f.rt;
    await ctx.io.sleep(250);
  }
  throw new CliError(
    t("cli.process.notListening", { seconds: Math.round((o.timeoutMs ?? START_TIMEOUT_MS) / 1000), tail: tailOfLog(ctx.dataDir) }),
    t("cli.process.notListeningFix", { log: logFile(ctx.dataDir) }),
  );
}

function tailOfLog(dataDir: string): string {
  try {
    const lines = readFileSync(logFile(dataDir), "utf8").trimEnd().split("\n");
    const tail = lines
      .slice(-6)
      .filter((l) => !/ExperimentalWarning|--trace-warnings/.test(l))
      .join("\n    ");
    return tail ? t("cli.process.logTail", { tail }) : "";
  } catch {
    return "";
  }
}

export interface StartOptions {
  foreground?: boolean;
  port?: number;
}

/** The log folder (0700), the log rotated once past 10 MB. */
function rotateLog(dataDir: string) {
  mkdirSync(logsDir(dataDir), { recursive: true, mode: 0o700 });
  const file = logFile(dataDir);
  try {
    if (statSync(file).size > LOG_ROTATE_BYTES) renameSync(file, file + ".1");
  } catch {}
}

/** Open the log for appending (0600; rotated once past 10 MB). */
function openLog(dataDir: string): number {
  rotateLog(dataDir);
  const file = logFile(dataDir);
  const fd = openSync(file, "a", 0o600);
  try {
    chmodSync(file, 0o600);
  } catch {}
  return fd;
}

/** The environment the Daisy process gets. */
export function childEnv(ctx: Ctx, o: StartOptions): NodeJS.ProcessEnv {
  // P6-11 review: what this command took from runner.json is not passed
  // on — the Daisy process reads runner.json itself (a later edit counts).
  const env = withoutFileSettings({ ...ctx.io.env }) as NodeJS.ProcessEnv;
  // Not systemd's: a reparented child must not think systemd restarts it.
  delete env.INVOCATION_ID;
  delete env.JOURNAL_STREAM;
  // Nor launchd's (P5-04).
  delete env.DAISY_LAUNCHD_LABEL;
  delete env.DAISY_RESPAWN_AFTER;
  // P5-06 (ADR-145): no service manager, so on a restart (an update, the
  // owner's) it starts its successor itself (restart.ts `respawn`).
  for (const k of envNames("DAISY_RUNNER_SELF_RESTART")) delete env[k];
  env.DAISY_RESPAWN = "1";
  env.DAISY_DATA = resolve(ctx.dataDir);
  if (o.port) env.DAISY_PORT = String(o.port);
  return env;
}

export type StartResult = { rt: Runtime; already: boolean; via: "systemd" | "launchd" | "windows-run" | "process" };

/** The service manager's state where there is one (Linux systemd, macOS launchd, the Windows Run entry). */
export const managed = (ctx: Ctx): Promise<AutostartState | null> =>
  ["linux", "darwin", "win32"].includes(ctx.io.platform) ? autostartState(ctx) : Promise.resolve(null);

export async function startDaisy(ctx: Ctx, o: StartOptions = {}): Promise<StartResult> {
  const f = locate(ctx.dataDir);
  if (f.state === "running") {
    if (await health(f.rt.local.url)) return { rt: f.rt, already: true, via: "process" };
    // Its process is there but does not answer: starting up, or hung.
    try {
      return { rt: await waitUntilUp(ctx, { since: 0, pid: f.rt.pid, timeoutMs: 15_000 }), already: true, via: "process" };
    } catch {
      throw new CliError(
        t("cli.process.hung", { pid: f.rt.pid, dir: ctx.dataDir }),
        t("cli.process.hungFix", { pid: f.rt.pid, log: logFile(ctx.dataDir) }),
      );
    }
  }
  if (!existsSync(SERVER_MAIN))
    throw new CliError(t("cli.process.noServer", { file: SERVER_MAIN }), t("cli.process.noServerFix"));
  const since = Date.now();
  if (o.foreground) return { rt: await foreground(ctx, o), already: false, via: "process" };

  const auto = await managed(ctx);
  if (auto?.installed) {
    if (o.port)
      throw usageError(
        t("cli.process.portManaged", {
          by: t(auto.manager === "launchd" ? "cli.process.by.launchd" : auto.manager === "windows-run" ? "cli.process.by.windows" : "cli.process.by.systemd"),
        }),
        t("cli.process.portManagedFix"),
      );
    if (auto.manager === "launchd") return { rt: await startByLaunchd(ctx, auto, since), already: false, via: "launchd" };
    if (auto.manager === "windows-run") {
      const r = await startOnWindows(ctx, o, since, auto);
      if (r) return r;
    }
    const r = await systemctl(ctx.io, "start", auto.unit);
    if (r.code !== 0)
      throw new CliError(
        t("cli.process.systemdStartFailed", { unit: auto.unit, why: r.stderr.trim().split("\n")[0] ?? "" }),
        t("cli.process.systemdStartFix", { unit: auto.unit }),
      );
    return { rt: await waitUntilUp(ctx, { since }), already: false, via: "systemd" };
  }

  if (process.platform === "win32") {
    const r = await startOnWindows(ctx, o, since, null);
    if (r) return r;
  }
  const fd = openLog(ctx.dataDir);
  const c = serverCommand();
  const child = spawn(c.node, c.args, {
    cwd: c.cwd,
    env: childEnv(ctx, o),
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  closeSync(fd);
  let exitCode: number | null = null;
  child.on("exit", (code, signal) => (exitCode = code ?? (signal ? 128 : 1)));
  child.on("error", () => (exitCode = 127));
  child.unref();
  try {
    const rt = await waitUntilUp(ctx, { since, pid: child.pid, exited: () => exitCode });
    return { rt, already: false, via: "process" };
  } catch (e) {
    // Never leave a half-started process behind.
    if (exitCode === null && child.pid) {
      try {
        process.kill(child.pid, "SIGTERM");
      } catch {}
    }
    throw e;
  }
}

/**
 * macOS: load the LaunchAgent (RunAtLoad starts it), or start the job
 * already loaded. Needs the owner's GUI domain: someone logged in to this
 * Mac's desktop (an ssh session alone has none).
 */
async function startByLaunchd(ctx: Ctx, auto: AutostartState, since: number): Promise<Runtime> {
  rotateLog(ctx.dataDir);
  const target = `${guiDomain()}/${auto.unit}`;
  const r = auto.loaded
    ? await launchctl(ctx.io, "kickstart", target)
    : await launchctl(ctx.io, "bootstrap", guiDomain(), auto.file);
  if (r.code !== 0)
    throw new CliError(
      t("cli.process.launchdStartFailed", { unit: auto.unit, why: r.stderr.trim().split("\n")[0] || t("cli.process.exitCode", { code: r.code }) }),
      t("cli.process.launchdStartFix", { domain: guiDomain(), target }),
    );
  return waitUntilUp(ctx, { since });
}

/**
 * Windows (P5-05): through the helper's `supervise` (null: no helper — the
 * plain background process below, which may flash console windows).
 * Started again after exit 75 or a crash either way; `auto`: the Run entry
 * is on — the command it holds (rewritten when it names an older helper).
 */
async function startOnWindows(ctx: Ctx, o: StartOptions, since: number, auto: AutostartState | null): Promise<StartResult | null> {
  const helper = winHelper();
  if (!helper) return null;
  const input = superviseInputFor(ctx, helper);
  if (auto && auto.value !== runEntry(input))
    await ctx.io.exec(WIN_HELPER_CMD, ["run-set", input.name, runEntry(input)]);
  rotateLog(ctx.dataDir);
  const env = childEnv(ctx, o);
  // The supervisor starts it again after exit 75 (an update, a restart):
  // it does not start its own successor (P5-06's respawn).
  delete env.DAISY_RESPAWN;
  for (const k of envNames("DAISY_RUNNER_SELF_RESTART")) delete env[k];
  const child = spawn(helper, superviseArgs(input), {
    cwd: input.cwd,
    env,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  let exitCode: number | null = null;
  child.on("exit", (code) => (exitCode = code ?? 1));
  child.on("error", () => (exitCode = 127));
  child.unref();
  try {
    const rt = await waitUntilUp(ctx, { since, exited: () => exitCode });
    return { rt, already: false, via: auto ? "windows-run" : "process" };
  } catch (e) {
    if (exitCode === null)
      try {
        child.kill();
      } catch {}
    throw e;
  }
}

/** `--foreground`: run here, pass signals on, exit with its code. */
async function foreground(ctx: Ctx, o: StartOptions): Promise<never> {
  const c = serverCommand();
  const env = childEnv(ctx, o);
  // In this terminal: exiting ends it (nothing to start a successor).
  delete env.DAISY_RESPAWN;
  if (ctx.io.env.INVOCATION_ID) env.INVOCATION_ID = ctx.io.env.INVOCATION_ID;
  const child = spawn(c.node, c.args, { cwd: c.cwd, env, stdio: "inherit" });
  const pass = (s: NodeJS.Signals) => () => child.kill(s);
  process.on("SIGINT", pass("SIGINT"));
  process.on("SIGTERM", pass("SIGTERM"));
  const code: number = await new Promise((r) => child.on("exit", (code, sig) => r(code ?? (sig ? 128 : 1))));
  process.exit(code);
}

export type StopResult = { was: "absent" | "stale" | "stopped"; pid?: number; via?: "systemd" | "launchd" | "signal" };

/** Wait for a process to be gone. */
async function gone(ctx: Ctx, pid: number, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (!pidAlive(pid)) return true;
    await ctx.io.sleep(200);
  }
  return !pidAlive(pid);
}

/** Is `pid` this data directory's Daisy (answers health, or runs main.ts)? */
async function isOurs(ctx: Ctx, rt: Runtime): Promise<boolean> {
  if (await health(rt.local.url, 2000)) return true;
  // Windows has no `ps`: a Daisy that does not answer is not told apart.
  if (process.platform === "win32") return false;
  const r = await ctx.io.exec("ps", ["-o", "command=", "-p", String(rt.pid)]);
  // P1-02b: a Daisy started before the move runs services/server/src/main.ts.
  return (
    r.code === 0 &&
    (r.stdout.includes("packages/daisy/src/main.ts") ||
      r.stdout.includes("services/server/src/main.ts"))
  );
}

export async function stopDaisy(ctx: Ctx): Promise<StopResult> {
  const f = locate(ctx.dataDir);
  const auto = await managed(ctx);
  if (auto?.manager === "launchd" && auto.loaded) {
    // Unload it: launchd sends SIGTERM (ExitTimeOut 45 s, then SIGKILL)
    // and does not start it again until `daisy start` or the next login.
    const target = `${guiDomain()}/${auto.unit}`;
    const r = await launchctl(ctx.io, "bootout", target);
    if (r.code !== 0 && auto.active)
      throw new CliError(
        t("cli.process.launchdStopFailed", { unit: auto.unit, why: r.stderr.trim().split("\n")[0] || t("cli.process.exitCode", { code: r.code }) }),
        t("cli.process.launchdStopFix", { target }),
      );
    if (auto.active) {
      const pid = auto.mainPid ?? (f.state === "running" ? f.rt.pid : undefined);
      if (pid && !(await gone(ctx, pid, STOP_TIMEOUT_MS))) throw stillThere(pid);
      return { was: "stopped", ...(pid ? { pid } : {}), via: "launchd" };
    }
    // Loaded but not running: unloaded; a background process may still run.
  }
  if (auto?.manager === "systemd" && auto.active) {
    const r = await systemctl(ctx.io, "stop", auto.unit);
    if (r.code !== 0)
      throw new CliError(
        t("cli.process.systemdStopFailed", { unit: auto.unit, why: r.stderr.trim().split("\n")[0] ?? "" }),
        t("cli.process.systemdStopFix", { unit: auto.unit }),
      );
    const pid = auto.mainPid ?? (f.state === "running" ? f.rt.pid : undefined);
    if (pid && !(await gone(ctx, pid, STOP_TIMEOUT_MS)))
      throw stillThere(pid);
    return { was: "stopped", ...(pid ? { pid } : {}), via: "systemd" };
  }
  if (f.state === "absent") return { was: "absent" };
  if (f.state === "stale") return { was: "stale", pid: f.rt.pid };
  if (!(await isOurs(ctx, f.rt)))
    throw new CliError(
      t("cli.process.notOurs", { pid: f.rt.pid }),
      t("cli.process.notOursFix", { pid: f.rt.pid, dir: ctx.dataDir }),
    );
  // Windows (P5-05): no SIGTERM there — a stop request the process acts on.
  if (process.platform === "win32") {
    requestStop(ctx.dataDir, f.rt.pid);
    if (!(await gone(ctx, f.rt.pid, STOP_TIMEOUT_MS))) throw stillThere(f.rt.pid);
    return { was: "stopped", pid: f.rt.pid, via: "signal" };
  }
  try {
    process.kill(f.rt.pid, "SIGTERM");
  } catch (e: any) {
    if (e?.code === "EPERM")
      throw new CliError(
        t("cli.process.noPermission", { pid: f.rt.pid }),
        t("cli.process.noPermissionFix"),
      );
  }
  if (!(await gone(ctx, f.rt.pid, STOP_TIMEOUT_MS))) throw stillThere(f.rt.pid);
  return { was: "stopped", pid: f.rt.pid, via: "signal" };
}

const stillThere = (pid: number) =>
  new CliError(
    t("cli.process.stillThere", { seconds: STOP_TIMEOUT_MS / 1000, pid }),
    t("cli.process.stillThereFix", { kill: process.platform === "win32" ? `taskkill /PID ${pid} /F` : `kill -9 ${pid}` }),
  );

/** PIN set? (D-36) — null when this Daisy has no PIN routes yet. */
export async function pinState(
  daisy: Daisy,
): Promise<{ set: boolean; lockedUntil: number | null } | null> {
  try {
    const r = await callRoute(daisy, ROUTES.pinStatus);
    return { set: !!r.data?.set, lockedUntil: r.data?.lockedUntil ?? null };
  } catch (e: any) {
    if (e?.status === 404 || e?.code === "route_not_defined") return null;
    throw e;
  }
}

