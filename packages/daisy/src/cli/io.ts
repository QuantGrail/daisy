/**
 * P1-07: everything the `daisy` command touches outside itself — the
 * terminal, the environment, child programs — behind one object, so the
 * tests run each command in process with a temporary data directory and
 * scripted input (tests/cli-*.test.ts).
 */
import { execFile, spawn } from "node:child_process";
import { blockedUnderTest } from "../platform/autostart.ts";
import { t } from "./lang.ts";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  /** ENOENT: the program is not installed. */
  missing?: boolean;
  /** Killed after `timeoutMs`. */
  timedOut?: boolean;
}

export interface Io {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  /** A line (or lines) for the person: standard output. */
  out(text: string): void;
  /** Problems and prompts: standard error. */
  err(text: string): void;
  /** Bytes to standard output (a download). */
  write(bytes: Uint8Array): void;
  /** Standard input is a terminal (prompts possible). */
  stdinTTY: boolean;
  /** Standard output is a terminal (binary must not go there). */
  stdoutTTY: boolean;
  /**
   * A credential (PIN, API key, authorization code): from a prompt that
   * does not echo, or the next line of standard input when it is piped.
   * Never from the command line (ADR-107 §2b).
   */
  readSecret(prompt: string): Promise<string>;
  /** A visible answer (a yes/no). Piped: the next line of standard input. */
  readLine(prompt: string): Promise<string>;
  /** All of standard input (`--json -`, a positional `-`). */
  readAll(): Promise<string>;
  /** Run a program; never throws (a missing program is `missing`). */
  exec(
    cmd: string,
    args: readonly string[],
    opts?: { timeoutMs?: number; env?: Record<string, string | undefined> },
  ): Promise<ExecResult>;
  sleep(ms: number): Promise<void>;
  /** Open a link in the desktop's browser; false when it could not. */
  openUrl(url: string): boolean;
}

/** Lines of piped standard input, read once, handed out in order. */
class PipedLines {
  private lines: string[] | null = null;
  private all: string | null = null;
  constructor(private read: () => Promise<string>) {}
  async text() {
    if (this.all === null) this.all = await this.read();
    return this.all;
  }
  async next(): Promise<string | null> {
    if (this.lines === null) this.lines = (await this.text()).split(/\r?\n/);
    if (this.lines.length === 0) return null;
    const l = this.lines.shift()!;
    // The empty string after a final newline is not a line.
    if (this.lines.length === 0 && l === "") return null;
    return l;
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** A prompt that does not echo what is typed (raw mode on the terminal). */
function promptHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(prompt);
    let value = "";
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const done = (fn: () => void) => {
      stdin.setRawMode?.(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stderr.write("\n");
      fn();
    };
    const onData = (s: string) => {
      for (const ch of s) {
        if (ch === "\r" || ch === "\n") return done(() => resolve(value));
        if (ch === "\u0003")
          return done(() => reject(Object.assign(new Error(t("cli.input.cancelled")), { cancelled: true })));
        if (ch === "\u0004" && value === "")
          return done(() => reject(Object.assign(new Error(t("cli.input.cancelled")), { cancelled: true })));
        if (ch === "\u007f" || ch === "\b") value = [...value].slice(0, -1).join("");
        else if (ch >= " ") value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

function promptVisible(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stderr.write(prompt);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    let buf = "";
    const onData = (s: string) => {
      buf += s;
      const i = buf.search(/\r?\n/);
      if (i < 0) return;
      process.stdin.off("data", onData);
      process.stdin.pause();
      resolve(buf.slice(0, i));
    };
    process.stdin.on("data", onData);
  });
}

/** The real terminal and process. */
export function processIo(): Io {
  // `daisy … | head`: the reader went away; that is not an error.
  for (const s of [process.stdout, process.stderr])
    s.on("error", (e: any) => {
      if (e?.code === "EPIPE") process.exit(process.exitCode ?? 0);
      throw e;
    });
  const piped = new PipedLines(readStdin);
  const stdinTTY = !!process.stdin.isTTY;
  return {
    env: process.env,
    platform: process.platform,
    out: (t) => process.stdout.write(t.endsWith("\n") ? t : t + "\n"),
    err: (t) => process.stderr.write(t.endsWith("\n") ? t : t + "\n"),
    write: (b) => process.stdout.write(b),
    stdinTTY,
    stdoutTTY: !!process.stdout.isTTY,
    async readSecret(prompt) {
      if (stdinTTY) return promptHidden(prompt);
      const l = await piped.next();
      if (l === null) throw new Error(t("cli.io.noMoreLines"));
      return l;
    },
    async readLine(prompt) {
      if (stdinTTY) return promptVisible(prompt);
      return (await piped.next()) ?? "";
    },
    readAll: () => piped.text(),
    exec: (cmd, args, opts = {}) =>
      new Promise((resolve) => {
        const blocked = blockedUnderTest(cmd);
        if (blocked) return resolve(blocked);
        execFile(
          cmd,
          [...args],
          {
            timeout: opts.timeoutMs ?? 15_000,
            env: (opts.env ?? process.env) as NodeJS.ProcessEnv,
            encoding: "utf8",
            maxBuffer: 4 * 1024 * 1024,
          },
          (e: any, stdout, stderr) => {
            if (e?.code === "ENOENT")
              return resolve({ code: 127, stdout: "", stderr: "", missing: true });
            resolve({
              code: e ? (typeof e.code === "number" ? e.code : 1) : 0,
              stdout: String(stdout ?? ""),
              stderr: String(stderr ?? ""),
              ...(e?.killed ? { timedOut: true } : {}),
            });
          },
        );
      }),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    openUrl: (url) => openBrowser(url, process.platform),
  };
}

/** Open a link in the desktop's browser, without waiting for it. */
export function openBrowser(url: string, platform: NodeJS.Platform): boolean {
  const [cmd, args] =
    platform === "darwin"
      ? ["open", [url]]
      : platform === "win32"
        ? // Not `cmd /c start`: cmd would split the link at its `&` (P5-05).
          ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  try {
    const c = spawn(cmd as string, args as string[], {
      stdio: "ignore",
      detached: true,
    });
    c.on("error", () => {});
    c.unref();
    return true;
  } catch {
    return false;
  }
}
