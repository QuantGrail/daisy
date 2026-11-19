/**
 * P5-05 (ADR-141): starting a program on Windows without a shell.
 *
 * - `quoteArg` / `commandLine`: an argv as one CreateProcess command line,
 *   quoted the way the Microsoft C runtime and CommandLineToArgvW split it
 *   back (2n backslashes + quote → n backslashes, a literal quote is \").
 *   Used for the line the helper hands to CreateProcess and for the HKCU
 *   Run entry; never passed through cmd.exe.
 * - `resolveCommand`: what `claude` / `codex` / `kimi` … is — searched on
 *   PATH × PATHEXT only (never the current folder: a workspace could hold a
 *   `claude.cmd`). An .exe / .com runs as it is. A .cmd / .bat is not run
 *   through cmd.exe — its `%*` would re-parse the arguments (`&`, `|`, `^`
 *   in a prompt or a path), and Node refuses to spawn one without a shell
 *   (CVE-2024-27980) — instead an npm / pnpm shim is read for the script it
 *   starts, and that script runs under node directly. A batch file that is
 *   not such a shim is refused with what to do.
 *   A Node script named by its path (`.js` / `.cjs` / `.mjs`, or a
 *   `#!…node` first line) runs under this Node: Windows has no shebangs.
 * - `windowsShell`: what runs a command line the person or the AI typed
 *   (「在终端执行」, background commands): Git Bash when Git for Windows is
 *   installed (what Claude Code and Kimi Code use there too), else Windows
 *   PowerShell with the command passed as -EncodedCommand (no quoting at all).
 */
import { ownerT } from "../language.ts";
import { readFileSync, statSync } from "node:fs";
import { win32 } from "node:path";
import { envGet } from "./helper.ts";

type Env = Record<string, string | undefined>;

/** One argument, quoted for CreateProcess (MSVCRT / CommandLineToArgvW rules). */
export function quoteArg(a: string): string {
  if (a.includes("\0")) throw new Error("an argument contains a NUL character");
  if (a.length && !/[\s"]/.test(a)) return a;
  let out = '"';
  let slashes = 0;
  for (const ch of a) {
    if (ch === "\\") {
      slashes++;
      continue;
    }
    if (ch === '"') {
      out += "\\".repeat(slashes * 2 + 1) + '"';
    } else out += "\\".repeat(slashes) + ch;
    slashes = 0;
  }
  return out + "\\".repeat(slashes * 2) + '"';
}

export const commandLine = (argv: readonly string[]) => argv.map(quoteArg).join(" ");

/** The reverse (CommandLineToArgvW's rules, without its argv[0] special case): for tests and checks. */
export function splitCommandLine(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i]!)) i++;
    if (i >= line.length) break;
    let arg = "",
      quoted = false;
    for (; i < line.length; i++) {
      const ch = line[i]!;
      if (!quoted && /\s/.test(ch)) break;
      if (ch === "\\") {
        let n = 0;
        while (line[i] === "\\") {
          n++;
          i++;
        }
        if (line[i] === '"') {
          arg += "\\".repeat(Math.floor(n / 2));
          if (n % 2) arg += '"';
          else quoted = !quoted;
        } else {
          arg += "\\".repeat(n);
          i--;
        }
        continue;
      }
      if (ch === '"') {
        quoted = !quoted;
        continue;
      }
      arg += ch;
    }
    out.push(arg);
  }
  return out;
}

export interface Fs {
  isFile(p: string): boolean;
  read(p: string): string;
}
export const realFs: Fs = {
  isFile: (p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  },
  read: (p) => readFileSync(p, "utf8"),
};

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";
const hasSep = (s: string) => /[\\/]/.test(s);

/** The first file `name` names on PATH × PATHEXT (or as a path), never the current folder. */
export function findOnPath(name: string, env: Env, fs: Fs = realFs): string | null {
  const exts = (envGet(env, "PATHEXT") || DEFAULT_PATHEXT)
    .split(";")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.startsWith("."));
  const own = win32.extname(name).toLowerCase();
  const names = own && exts.includes(own) ? [name] : exts.map((e) => name + e);
  if (hasSep(name) || win32.isAbsolute(name)) {
    if (!win32.isAbsolute(name)) return null;
    return names.find((n) => fs.isFile(n)) ?? null;
  }
  for (const raw of (envGet(env, "PATH") || "").split(";")) {
    const dir = raw.trim().replace(/^"(.*)"$/, "$1");
    if (!dir || !win32.isAbsolute(dir)) continue;
    for (const n of names) {
      const p = win32.join(dir, n);
      if (fs.isFile(p)) return p;
    }
  }
  return null;
}

/**
 * What an npm (cmd-shim) or pnpm `.cmd` starts: the script under its
 * folder and the program that runs it (null: not such a shim).
 */
export function parseShim(text: string): { script: string; prog: string } | null {
  // The script: the last `"%dp0%\…"` / `"%~dp0\…"` before %*.
  const re = /"%~?dp0%?\\([^"%]+)"\s*%\*/gi;
  let m: RegExpExecArray | null,
    last: string | null = null;
  while ((m = re.exec(text))) last = m[1]!;
  if (!last) return null;
  // The program: `SET "_prog=node"` (cmd-shim), else `node` when the shim names it.
  const prog = /SET\s+"_prog=([^"%]+)"/i.exec(text)?.[1] ?? (/\bnode(\.exe)?\b/i.test(text) ? "node" : null);
  if (!prog) return null;
  return { script: last, prog: prog.replace(/\.exe$/i, "") };
}

export class CommandRefused extends Error {}

/**
 * How to start `name` with `args` on Windows without a shell, or null when
 * it is not installed (the caller's spawn then fails with ENOENT as it
 * always did).
 */
export function resolveCommand(
  name: string,
  args: readonly string[],
  env: Env,
  fs: Fs = realFs,
  nodeFallback: string = process.execPath,
): { file: string; args: string[] } | null {
  // A Node script named by path (DAISY_CLAUDE_BIN=C:\…\cli.js, a
  // `#!/usr/bin/env node` file): Windows has no shebangs — run it with node.
  if (win32.isAbsolute(name) && fs.isFile(name) && !/\.(exe|com|cmd|bat)$/i.test(name)) {
    const head = /\.[cm]?js$/i.test(name) ? "" : fs.read(name).slice(0, 200);
    if (/\.[cm]?js$/i.test(name) || /^#!.*\bnode\b/.test(head))
      return { file: nodeFallback, args: [name, ...args] };
    throw new CommandRefused(ownerT()("server-platform.windows.notRunnable", { name }));
  }
  const file = findOnPath(name, env, fs);
  if (!file) return null;
  const ext = win32.extname(file).toLowerCase();
  if (ext !== ".cmd" && ext !== ".bat") return { file, args: [...args] };
  const shim = parseShim(fs.read(file));
  if (!shim)
    throw new CommandRefused(
      ownerT()("server-platform.windows.batchFile", { file }),
    );
  const dir = win32.dirname(file);
  const script = win32.join(dir, shim.script);
  let prog: string | null;
  if (shim.prog === "node") {
    const beside = win32.join(dir, "node.exe");
    prog = fs.isFile(beside) ? beside : (findOnPath("node", env, fs) ?? nodeFallback);
  } else prog = findOnPath(shim.prog, env, fs);
  if (!prog || /\.(cmd|bat)$/i.test(prog))
    throw new CommandRefused(ownerT()("server-platform.windows.noProgram", { file, prog: shim.prog }));
  return { file: prog, args: [script, ...args] };
}

/** A UTF-16LE base64 script for `powershell -EncodedCommand`. */
export const encodePowerShell = (script: string) => Buffer.from(script, "utf16le").toString("base64");

export interface WindowsShell {
  kind: "git-bash" | "powershell";
  file: string;
  /** The arguments that run `command` (login shell for 「在终端执行」, like bash -lc). */
  args(command: string, login?: boolean): string[];
  /** Extra environment (Git Bash: stay in the working folder). */
  env: Record<string, string>;
}

/** Git Bash if Git for Windows is installed, else Windows PowerShell. Never WSL's bash.exe. */
export function windowsShell(env: Env, isFile: (p: string) => boolean = realFs.isFile): WindowsShell {
  const roots = [
    envGet(env, "ProgramFiles"),
    envGet(env, "ProgramW6432"),
    envGet(env, "LOCALAPPDATA") && win32.join(envGet(env, "LOCALAPPDATA")!, "Programs"),
  ].filter(Boolean) as string[];
  const candidates = roots.map((r) => win32.join(r, "Git", "bin", "bash.exe"));
  const git = findOnPath("git", env, { isFile, read: () => "" });
  // …\Git\cmd\git.exe or …\Git\bin\git.exe → …\Git\bin\bash.exe
  if (git) candidates.push(win32.join(win32.dirname(win32.dirname(git)), "bin", "bash.exe"));
  const system = (envGet(env, "SystemRoot") || "C:\\Windows").toLowerCase();
  const bash = candidates.find((p) => isFile(p) && !p.toLowerCase().startsWith(system));
  if (bash)
    return {
      kind: "git-bash",
      file: bash,
      args: (command, login = false) => [login ? "-lc" : "-c", command],
      env: { CHERE_INVOKING: "1", MSYSTEM: "MINGW64" },
    };
  return {
    kind: "powershell",
    file: win32.join(envGet(env, "SystemRoot") || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: (command) => [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encodePowerShell(command),
    ],
    env: {},
  };
}

