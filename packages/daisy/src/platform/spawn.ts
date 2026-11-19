/**
 * P5-05 (ADR-141): starting a process tree Daisy can end whole, the same
 * call on every system.
 *
 * - Linux / macOS: as before — its own process group (`detached`), so
 *   stopping it signals the group and every descendant by parent
 *   (process-groups.ts `processTree`).
 * - Windows: there are no process groups. The program runs under the
 *   helper's `job` command (windows/daisy-win.cs): created suspended, put in
 *   a fresh Job Object with KILL_ON_JOB_CLOSE, resumed — so everything it
 *   starts is in the job. Ending the helper (child.kill(), Daisy exiting or
 *   dying: the helper is Daisy's child in Node's own kill-on-close job, and
 *   it watches Daisy's pid) closes the job's only handle and Windows ends
 *   the whole tree. The program is found on PATH × PATHEXT without a shell
 *   (windows/cmdline.ts); its standard handles are Daisy's pipes.
 *
 * `resolveSpawn` is the same lookup for a quick `execFile` (a version or
 * status probe) that needs no tree.
 */
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { log } from "../observe/log.ts";
import { childUmask, octal } from "./umask.ts";
import { commandLine, resolveCommand } from "./windows/cmdline.ts";
import { helperExe } from "./windows/helper.ts";

type Env = Record<string, string | undefined>;

/** `command args` as Windows can start them without a shell (identity elsewhere). */
export function resolveSpawn(
  command: string,
  args: readonly string[],
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
): [string, string[]] {
  if (platform !== "win32") return [command, [...args]];
  const r = resolveCommand(command, args, env);
  return r ? [r.file, r.args] : [command, [...args]];
}

/** The helper's `job` / `pty` arguments for a resolved program (pure; tests read it). */
export function helperArgs(
  mode: "job" | "pty",
  file: string,
  args: readonly string[],
  o: { parent?: number; cols?: number; rows?: number; breakaway?: boolean } = {},
): string[] {
  return [
    mode,
    "--parent",
    String(o.parent ?? process.pid),
    ...(mode === "pty" ? ["--cols", String(o.cols ?? 100), "--rows", String(o.rows ?? 30)] : []),
    ...(o.breakaway ? ["--breakaway-ok"] : []),
    "--app",
    file,
    "--cmdline",
    commandLine([file, ...args]),
  ];
}

/**
 * DAISY_WIN_JOB_BREAKAWAY=1 lets a program in the job start a child with
 * CREATE_BREAKAWAY_FROM_JOB (a harness's own sandbox might need it); that
 * child then leaves the job and is only found by parent at a stop (ADR-141).
 */
const breakawayOk = () => process.env.DAISY_WIN_JOB_BREAKAWAY === "1";

/**
 * `command` as an absolute path: as given when absolute, else found on the
 * absolute entries of `PATH`; null when not found or relative (review L2:
 * a relative PATH entry or path is not resolved here — the program is then
 * started unwrapped, exactly as before).
 */
export function onPath(command: string, path: string | undefined): string | null {
  if (command.includes("/")) return isAbsolute(command) ? command : null;
  for (const d of (path ?? "").split(delimiter)) {
    if (!d || !isAbsolute(d)) continue;
    const f = join(d, command);
    try {
      if (statSync(f).isFile()) {
        accessSync(f, constants.X_OK);
        return f;
      }
    } catch {}
  }
  return null;
}

/**
 * P6-15 (ADR-158): `command args` started under file-creation mask `mask`
 * (POSIX): `/bin/sh -c 'umask 0022 && exec "$0" "$@"' <file> args…` — the
 * shell replaces itself with the program, so the pid, the process group
 * and the signals are the program's. The program is always an absolute
 * path (it starts with "/", so `exec` cannot take it for an option; `exec
 * --` is left out because not every /bin/sh accepts it). A program not
 * found is started as asked, so the caller still sees ENOENT.
 */
export function underUmask(
  command: string,
  args: readonly string[],
  mask: number,
  path: string | undefined,
): [string, string[]] {
  const file = onPath(command, path);
  if (!file) return [command, [...args]];
  return ["/bin/sh", ["-c", `umask ${octal(mask)} && exec "$0" "$@"`, file, ...args]];
}

let warned = false;
/**
 * Start `command args` as the root of a tree (see above). `mode: "pty"`
 * (Windows) attaches it to a pseudo console behind the terminal protocol.
 *
 * P6-15 (ADR-158): on Linux / macOS the program gets the file-creation mask
 * Daisy was started with (the AI's tools work in the owner's folders), not
 * Daisy's own 077 (platform/umask.ts). A login (turns/login.ts) is not
 * started here: it writes only into its identity home, under 077.
 */
export function spawnTree(
  command: string,
  args: readonly string[],
  options: SpawnOptions & { pty?: { cols: number; rows: number } } = {},
): ChildProcess {
  const { pty, ...opts } = options;
  if (process.platform !== "win32") {
    const mask = childUmask();
    const [file, argv] =
      mask === null ? [command, [...args]] : underUmask(command, args, mask, ((opts.env ?? process.env) as Env).PATH);
    return spawn(file, argv, { ...opts, detached: true });
  }
  const env = (opts.env ?? process.env) as Env;
  const r = resolveCommand(command, args, env);
  // Not installed: spawn it as asked, so the caller sees ENOENT as before.
  if (!r) return spawn(command, [...args], { ...opts, windowsHide: true });
  let exe: string;
  try {
    exe = helperExe();
  } catch (e: any) {
    if (pty) throw e;
    if (!warned) {
      warned = true;
      log.warn(
        `the Windows helper is not available (${e?.message ?? e}): harnesses start directly; stopping finds their descendants by parent only, and they may stay behind if Daisy is killed`,
      );
    }
    return spawn(r.file, r.args, { ...opts, windowsHide: true });
  }
  return spawn(exe, helperArgs(pty ? "pty" : "job", r.file, r.args, { ...pty, breakaway: breakawayOk() }), {
    ...opts,
    detached: false,
    windowsHide: true,
  });
}
