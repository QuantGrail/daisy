/**
 * P5-05 (ADR-141): where Daisy's Windows helper (daisy-win.cs) comes from.
 *
 * No native Node addon and no build step at install: the helper is one C#
 * file, compiled on first use by the C# compiler every Windows 10 / 11 has
 * (.NET Framework 4.x's csc.exe under %SystemRoot%\Microsoft.NET), into a
 * per-user folder keyed by the source's hash —
 * %LOCALAPPDATA%\Programs\Daisy\helper\<hash>\daisy-win.exe (the Windows
 * convention for per-user programs; only this account can write there).
 * A newer Daisy with a changed helper compiles a new one beside it; a
 * running one keeps using its own.
 *
 * Everything here is synchronous and cached: compiling once costs a second
 * or two, after that it is a file check.
 */
import { ownerT } from "../language.ts";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, win32 } from "node:path";

export const HELPER_SOURCE = join(import.meta.dirname, "daisy-win.cs");

type Env = Record<string, string | undefined>;
/** A case-insensitive read of a Windows environment copy (`Path` vs `PATH`). */
export function envGet(env: Env, key: string): string | undefined {
  if (env[key] !== undefined) return env[key];
  const k = Object.keys(env).find((x) => x.toUpperCase() === key.toUpperCase());
  return k === undefined ? undefined : env[k];
}

/** The C# compilers that ship with Windows (64-bit first). */
export function cscCandidates(env: Env): string[] {
  const root = envGet(env, "SystemRoot") || envGet(env, "windir") || "C:\\Windows";
  return ["Framework64", "Framework"].map((f) =>
    win32.join(root, "Microsoft.NET", f, "v4.0.30319", "csc.exe"),
  );
}

/** Per-user folder for the compiled helper (DAISY_WIN_HELPER_DIR overrides, for tests). */
export function helperRoot(env: Env, home = homedir()): string {
  const explicit = envGet(env, "DAISY_WIN_HELPER_DIR");
  if (explicit) return explicit;
  const local = envGet(env, "LOCALAPPDATA") || win32.join(home, "AppData", "Local");
  return win32.join(local, "Programs", "Daisy", "helper");
}

export const sourceHash = (text: string) =>
  createHash("sha256").update(text).digest("hex").slice(0, 12);

/** The csc.exe arguments that compile `src` into `out` (GUI subsystem: never a console window). */
export function cscArgs(src: string, out: string): string[] {
  return ["/nologo", "/target:winexe", "/optimize+", "/utf8output", `/out:${out}`, src];
}

export class HelperUnavailable extends Error {}

let cached: { exe: string } | { error: string } | undefined;

/**
 * The helper's path, compiling it the first time (Windows only). Throws
 * HelperUnavailable with why — and keeps answering the same until this
 * process restarts, so a machine without csc does not retry per spawn.
 */
export function helperExe(env: Env = process.env): string {
  if (process.platform !== "win32") throw new HelperUnavailable(ownerT()("server-platform.windows.helperWindowsOnly"));
  if (cached) {
    if ("exe" in cached) return cached.exe;
    throw new HelperUnavailable(cached.error);
  }
  try {
    const text = readFileSync(HELPER_SOURCE, "utf8");
    const dir = win32.join(helperRoot(env), sourceHash(text));
    const exe = win32.join(dir, "daisy-win.exe");
    if (!existsSync(exe)) {
      const csc = cscCandidates(env).find((p) => existsSync(p));
      if (!csc)
        throw new Error(
          ownerT()("server-platform.windows.noCsc", { path: "%SystemRoot%\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe" }),
        );
      mkdirSync(dir, { recursive: true });
      const tmp = win32.join(dir, `daisy-win.${process.pid}.tmp.exe`);
      try {
        execFileSync(csc, cscArgs(HELPER_SOURCE, tmp), {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          timeout: 120_000,
        });
        // Another process may have won the race: same source, same result.
        if (!existsSync(exe)) renameSync(tmp, exe);
      } catch (e: any) {
        const out = String(e?.stdout ?? "") + String(e?.stderr ?? "");
        throw new Error(ownerT()("server-platform.windows.compileFailed", { why: (out || e?.message || e).toString().slice(0, 2000) }));
      } finally {
        rmSync(tmp, { force: true });
      }
    }
    cached = { exe };
    return exe;
  } catch (e: any) {
    cached = { error: String(e?.message ?? e) };
    throw new HelperUnavailable(cached.error);
  }
}

/** Whether the helper is there or can be made (never throws). */
export function helperAvailable(env: Env = process.env): boolean {
  try {
    helperExe(env);
    return true;
  } catch {
    return false;
  }
}

/** Run one of the helper's quick commands (ps, acl-get, …); its stdout. */
export function runHelper(args: string[], timeout = 10_000): string {
  return execFileSync(helperExe(), args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    timeout,
    maxBuffer: 32 * 1024 * 1024,
  });
}

/** Tests: forget what was found. */
export function resetHelperCache() {
  cached = undefined;
}
