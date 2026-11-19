/**
 * P1-07 test helpers: a scripted terminal (Io) and a stand-in Daisy (an
 * HTTP server that records requests and answers per route), with a
 * temporary data directory holding the runtime file and the command
 * line's credential exactly as the real process writes them.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult, Io } from "../packages/daisy/src/cli/io.ts";
import { run } from "../packages/daisy/src/cli/main.ts";

export interface TestIo extends Io {
  stdout: string[];
  stderr: string[];
  bytes: Uint8Array[];
  opened: string[];
  execs: { cmd: string; args: string[]; env?: Record<string, string | undefined> }[];
  /** All the text the person would have seen. */
  seen(): string;
}

const SERVICE_MANAGERS = new Set(["launchctl", "systemctl", "loginctl"]);

export function testIo(o: {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  /** Lines of standard input (secrets, answers), in order. */
  input?: string[];
  /** A fake program: return a result, or undefined to run it for real. */
  exec?: (
    cmd: string,
    args: string[],
    opts?: { timeoutMs?: number; env?: Record<string, string | undefined> },
  ) => ExecResult | undefined;
  stdinTTY?: boolean;
  stdoutTTY?: boolean;
} = {}): TestIo {
  const lines = [...(o.input ?? [])];
  const io: TestIo = {
    env: { ...process.env, ...o.env },
    platform: o.platform ?? process.platform,
    stdout: [],
    stderr: [],
    bytes: [],
    opened: [],
    execs: [],
    out: (t) => io.stdout.push(t),
    err: (t) => io.stderr.push(t),
    write: (b) => io.bytes.push(b),
    stdinTTY: o.stdinTTY ?? false,
    stdoutTTY: o.stdoutTTY ?? false,
    readSecret: async () => {
      if (!lines.length) throw new Error("no more input");
      return lines.shift()!;
    },
    readLine: async () => lines.shift() ?? "",
    readAll: async () => lines.splice(0).join("\n"),
    exec: async (cmd, args, opts) => {
      io.execs.push({ cmd, args: [...args], ...(opts?.env ? { env: opts.env } : {}) });
      const fake = o.exec?.(cmd, [...args], opts);
      if (fake) return fake;
      // P5-04: the real service managers are never driven from a test (the
      // owner's own launchd / systemd): unfaked, they are "not installed".
      if (SERVICE_MANAGERS.has(cmd)) return { code: 127, stdout: "", stderr: "", missing: true };
      return new Promise((resolve) =>
        execFile(cmd, [...args], { timeout: opts?.timeoutMs ?? 15_000, encoding: "utf8" }, (e: any, so, se) =>
          resolve(
            e?.code === "ENOENT"
              ? { code: 127, stdout: "", stderr: "", missing: true }
              : { code: e ? (typeof e.code === "number" ? e.code : 1) : 0, stdout: so, stderr: se },
          ),
        ),
      );
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50))),
    openUrl: (url) => {
      io.opened.push(url);
      return true;
    },
    seen: () => [...io.stdout, ...io.stderr].join("\n"),
  };
  return io;
}

export interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage["headers"];
  body: any;
}

export type Answer = { status?: number; json?: unknown; bytes?: Uint8Array };

export const CREDENTIAL = "dcli_" + "t".repeat(43);

/** A stand-in Daisy in a temporary data directory. */
export async function fakeDaisy(
  answer: (r: Recorded) => Answer | undefined = () => undefined,
): Promise<{ dataDir: string; url: string; requests: Recorded[]; close(): Promise<void>; root: string }> {
  const root = mkdtempSync(join(tmpdir(), "daisy-cli-"));
  const dataDir = join(root, "data");
  mkdirSync(join(dataDir, "keys"), { recursive: true, mode: 0o700 });
  const requests: Recorded[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const u = new URL(req.url!, "http://x");
      const text = Buffer.concat(chunks).toString("utf8");
      const r: Recorded = {
        method: req.method!,
        path: u.pathname,
        query: u.searchParams,
        headers: req.headers,
        body: text ? JSON.parse(text) : undefined,
      };
      if (u.pathname !== "/api/health") requests.push(r);
      let a: Answer | undefined;
      if (u.pathname === "/api/health") a = { json: { ok: true, apiVersion: 1 } };
      else if (req.headers.authorization !== `Bearer ${CREDENTIAL}`)
        a = { status: 401, json: { error: "没有有效的凭据", code: "unauthenticated" } };
      else a = answer(r) ?? { json: { ok: true, echo: { method: r.method, path: r.path } } };
      if (a.bytes) {
        res.writeHead(a.status ?? 200, { "content-type": "application/octet-stream" });
        res.end(Buffer.from(a.bytes));
        return;
      }
      res.writeHead(a.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(a.json ?? null));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  const url = `http://127.0.0.1:${port}`;
  const cred = join(dataDir, "keys", "cli-credential");
  writeFileSync(cred, CREDENTIAL + "\n", { mode: 0o600 });
  writeFileSync(
    join(dataDir, "runtime.json"),
    JSON.stringify({
      pid: process.pid,
      release: "0.1.0+test",
      startedAt: Date.now(),
      dataDir,
      local: { url, port, source: "derived" },
      external: null,
      cliCredential: cred,
    }),
    { mode: 0o600 },
  );
  return {
    root,
    dataDir,
    url,
    requests,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Run `daisy …` in process. */
export async function daisy(io: TestIo, dataDir: string, ...argv: string[]) {
  const code = await run(["--data-dir", dataDir, ...argv], io);
  return { code, out: io.stdout.join("\n"), err: io.stderr.join("\n") };
}
