import { turnT } from "../harness/model-switch.ts";
import { trackGroup, untrackGroup } from "../platform/process-groups.ts";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { spawnTree } from "../platform/spawn.ts";
import { windowsShell } from "../platform/windows/cmdline.ts";
import { existsSync } from "node:fs";
import { SCRUBBED_ENV, safeWorkspace } from "../harness/shared.ts";
import { RENAMED_ENV } from "../../../contracts/src/env.ts";
import { pluginEnvKeys } from "../plugins/runner.ts";
import { restartShellError, restartAborted } from "../update/restart.ts";
const HEAD = 16 * 1024,
  TAIL = 48 * 1024;
const ansi =
  // CSI / OSC sequences and lone escapes; enough for typical CLI colour output.
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
export interface ShellRequest {
  id: string;
  lease: string;
  command: string;
  cwd: string;
  timeoutMs: number;
}
/**
 * One 「在终端执行」 command: `bash -lc` in the session workspace
 * (Windows, P5-05: Git Bash `-lc`, else PowerShell),
 * as this runner's OS account (in host mode, the member's own), stdin closed,
 * killed with its whole process group at the timeout. The environment is the
 * runner's own minus Daisy / plugin AI attribution: the user typed it, not
 * the Agent (only Agent processes are marked).
 */
export function runShell(
  config: { allowedRoots: string[] },
  r: ShellRequest,
  signal: AbortSignal,
) {
  const started = Date.now();
  return new Promise<{
    exitCode: number | null;
    timedOut: boolean;
    output: string;
    truncated: boolean;
    durationMs: number;
    error?: string;
  }>((resolve) => {
    let cwd: string;
    try {
      cwd = safeWorkspace(r.cwd, config.allowedRoots);
      if (!existsSync(cwd)) throw Error(turnT()("server-turns.shell.noCwd"));
    } catch (e: any) {
      resolve({
        exitCode: null,
        timedOut: false,
        output: "",
        truncated: false,
        durationMs: 0,
        error: String(e.message).slice(0, 2000),
      });
      return;
    }
    const env: Record<string, string | undefined> = {
      ...process.env,
      TERM: "dumb",
      NO_COLOR: "1",
    };
    // P1-10: and what an enabled plugin sets for a session's own work
    // (attribution) — the Runner's own environment may carry it.
    const pluginKeys = new Set(pluginEnvKeys());
    for (const key of Object.keys(env))
      if (
        SCRUBBED_ENV.includes(key) ||
        pluginKeys.has(key) ||
        isDaisySetting(key)
      )
        delete env[key];
    // P5-05: on Windows Git Bash (login shell, like bash -lc), else
    // PowerShell; in a Job Object instead of a process group.
    const win = process.platform === "win32" ? windowsShell(env) : null;
    const child = spawnTree(
      win ? win.file : "/bin/bash",
      win ? win.args(r.command, true) : ["-lc", r.command],
      {
        cwd,
        env: { ...env, ...win?.env } as NodeJS.ProcessEnv,
        stdio: ["ignore", "pipe", "pipe"],
      },
    ) as ChildProcessByStdio<null, Readable, Readable>;
    // P1-02 / C-4: recorded, so a next start can end it if this process is killed.
    trackGroup(child.pid);
    child.once("exit", () => untrackGroup(child.pid));
    let head = "",
      tail = "",
      dropped = 0,
      timedOut = false,
      settled = false;
    // Decoded per stream so a multibyte character split across chunks stays whole.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const take = (chunk: string) => {
      let text = chunk;
      if (head.length < HEAD) {
        const room = HEAD - head.length;
        head += text.slice(0, room);
        text = text.slice(room);
      }
      tail += text;
      if (tail.length > TAIL) {
        dropped += tail.length - TAIL;
        tail = tail.slice(-TAIL);
      }
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const kill = () => {
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid!, "SIGKILL");
      } catch {}
    };
    // A background child (`cmd &`, `setsid …`) can keep the pipes open after
    // bash is gone, so `close` may never come: settle shortly after `exit`,
    // or shortly after the timeout kill, whichever happens.
    let exitCode: number | null = null,
      linger: ReturnType<typeof setTimeout> | undefined;
    const settleSoon = (ms: number) => {
      clearTimeout(linger);
      linger = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        done(timedOut ? null : exitCode);
      }, ms);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
      settleSoon(2000);
    }, r.timeoutMs);
    signal.addEventListener("abort", kill, { once: true });
    if (signal.aborted) kill();
    const done = (exitCode: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(linger);
      signal.removeEventListener("abort", kill);
      const clean = (s: string) =>
        s.replace(ansi, "").replace(/\r(?!\n)/g, "\n");
      const output = dropped
        ? `${clean(head)}\n${turnT()("server-turns.shell.dropped", { n: dropped })}\n${clean(tail)}`
        : clean(head + tail);
      // 立即重启 killed it: say so instead of a bare exit.
      if (!error && restartAborted(signal)) error = restartShellError();
      resolve({
        exitCode,
        timedOut,
        output,
        truncated: dropped > 0,
        durationMs: Date.now() - started,
        ...(error ? { error } : {}),
      });
    };
    child.on("error", (e) => done(null, String(e.message).slice(0, 2000)));
    child.on("exit", (code) => {
      exitCode = code;
      settleSoon(1000);
    });
    child.on("close", (code) => done(timedOut ? null : code));
  });
}

/**
 * Daisy's own settings are not passed to a background command: every old
 * `HARBOR_*` name, and the `DAISY_*` names they became (P6-03, ADR-153) —
 * including `DAISY_<ID>_BIN`.
 */
export function isDaisySetting(key: string): boolean {
  return (
    /^HARBOR_/.test(key) ||
    (RENAMED_ENV as readonly string[]).includes(key) ||
    /^DAISY_[A-Z0-9_]+_BIN$/.test(key)
  );
}
