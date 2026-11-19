import { daisyEnv } from "../../../contracts/src/env.ts";
import {
  setTimeout,
  setInterval,
  clearTimeout,
  clearInterval,
} from "node:timers";
import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { spawnTree } from "../platform/spawn.ts";
import { randomUUID } from "node:crypto";
import {
  aliveInTree,
  processTree,
  signalTree,
  trackGroup,
  untrackGroup,
} from "../platform/process-groups.ts";
/**
 * Largest single JSON line accepted from an agent process (counted in
 * UTF-16 code units of the buffered text, about bytes for JSON). A long native
 * history can make one response large (a resumed Codex thread with many
 * patches / screenshots exceeded the old 16 MiB and the session could no
 * longer run, compact or rewind); history is no longer requested on resume,
 * and this stays a guard against a runaway frame.
 */
export const MAX_FRAME_BYTES =
  Number(daisyEnv("DAISY_AGENT_FRAME_MAX_MIB")) > 0
    ? Number(daisyEnv("DAISY_AGENT_FRAME_MAX_MIB")) * 1024 * 1024
    : 128 * 1024 * 1024;
/** Newline JSON transport. Requests may resolve out of order; reverse requests never block parsing. */
export class JsonProcess {
  child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private pending = new Map<
    string,
    {
      resolve: (x: any) => void;
      reject: (x: Error) => void;
      timer: ReturnType<typeof setTimeout> | undefined;
    }
  >();
  onMessage: (x: any) => void = () => {};
  onExit: (error: Error) => void = () => {};
  stderr = "";
  closed = false;
  private stopping?: Promise<void>;
  constructor(
    command: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; readOnly?: string[] },
  ) {
    const { readOnly, ...spawnOptions } = options;
    if (readOnly) {
      args = [...readOnly, command, ...args];
      command = "/usr/bin/bwrap";
    }
    // Its own group (Linux / macOS) or its own Job Object (Windows, P5-05).
    this.child = spawnTree(command, args, {
      ...spawnOptions,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    // P1-02 / C-4: recorded, so a next start can end it if this process is killed.
    trackGroup(this.child.pid);
    this.child.once("exit", () => untrackGroup(this.child.pid));
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (s: string) => {
      // Only the new chunk can hold the next newline: no rescan of a long
      // partial line (a near-limit frame arrives in thousands of chunks).
      if (!s.includes("\n")) {
        this.buffer += s;
        if (this.buffer.length > MAX_FRAME_BYTES) {
          this.fail(
            Error(
              `Agent JSON frame exceeds ${Math.round(MAX_FRAME_BYTES / 1048576)} MiB`,
            ),
          );
          this.stop();
        }
        return;
      }
      this.buffer += s;
      if (this.buffer.length > MAX_FRAME_BYTES) {
        this.fail(
          Error(
            `Agent JSON frame exceeds ${Math.round(MAX_FRAME_BYTES / 1048576)} MiB`,
          ),
        );
        this.stop();
        return;
      }
      let i;
      while ((i = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, i);
        this.buffer = this.buffer.slice(i + 1);
        if (!line.trim()) continue;
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        const key = String(m.id ?? m.response?.request_id ?? "");
        const p = this.pending.get(key);
        if (p && !m.method && m.type !== "control_request") {
          clearTimeout(p.timer);
          this.pending.delete(key);
          if (m.error || m.response?.subtype === "error")
            p.reject(
              Error(
                m.error?.message || m.response?.error || "Agent request failed",
              ),
            );
          else p.resolve(m.result ?? m.response?.response ?? m);
        } else {
          try {
            this.onMessage(m);
          } catch (e) {
            this.fail(e as Error);
          }
        }
      }
    });
    this.child.stderr.on("data", (s: string) => {
      this.stderr = (this.stderr + s).slice(-8000);
    });
    this.child.on("error", (e) => this.fail(e));
    this.child.on("exit", (code, signal) =>
      this.fail(
        Error(`Agent exited (${code ?? signal}). ${this.stderr.slice(-2000)}`),
      ),
    );
    this.child.stdin.on("error", () => {});
  }
  private fail(e: Error) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
    this.onExit(e);
  }
  send(m: any) {
    if (this.closed) throw Error("Agent transport closed");
    this.child.stdin.write(JSON.stringify(m) + "\n");
  }
  request(method: string, params: any, timeout = 60_000) {
    const id = randomUUID();
    return this.wait(id, { jsonrpc: "2.0", id, method, params }, timeout);
  }
  /** `id`: the request_id (to cancel it later); a new one by default. */
  control(request: any, timeout = 60_000, id: string = randomUUID()) {
    return this.wait(
      id,
      { type: "control_request", request_id: id, request },
      timeout,
    );
  }
  private wait(id: string, message: any, timeout: number): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer =
        timeout > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(
                Error(
                  `Agent protocol timeout: ${message.method || message.request?.subtype}`,
                ),
              );
            }, timeout)
          : undefined;
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send(message);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  respond(id: string | number, result: any) {
    this.send({ jsonrpc: "2.0", id, result });
  }
  reject(id: string | number, message: string) {
    this.send({ jsonrpc: "2.0", id, error: { code: -32601, message } });
  }
  stop() {
    if (this.stopping) return;
    const child = this.child;
    if (!child.pid) return;
    // The harness's whole tree, noted before anything is signalled: its
    // group and every descendant by parent (one that left the group or
    // daemonized too), each with its start time so a reused pid is never
    // hit. /proc on Linux, `ps` on macOS (P5-04, ADR-140). Windows
    // (P5-05, ADR-141): the child is the job helper — ending it ends the
    // Job Object and with it the whole tree; the tree noted by parent is
    // what the wait below checks (and ends, should anything have left the job).
    const tree = processTree(child.pid);
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32") process.kill(-child.pid!, signal);
        else child.kill(signal);
      } catch {}
      signalTree(tree, signal);
    };
    kill("SIGTERM");
    // Reading the table is a `ps` on macOS (the helper's on Windows): look
    // every 100 ms there, every 20 ms where it is /proc.
    const every = process.platform === "linux" ? 20 : 100;
    this.stopping = (async () => {
      const since = Date.now();
      let looked = 0,
        killed = 0,
        others = tree.length > 0;
      while (true) {
        if (others && Date.now() - looked >= every) {
          looked = Date.now();
          others = aliveInTree(tree.filter((t) => t.pid !== child.pid)) > 0;
        }
        const alive =
          (child.exitCode === null && child.signalCode === null) || others;
        if (!alive) return;
        if (Date.now() - since >= 1500 && Date.now() - killed >= 250) {
          killed = Date.now();
          kill("SIGKILL");
        }
        await new Promise((r) => setTimeout(r, 20));
      }
    })();
  }
  whenStopped(): Promise<void> {
    return this.stopping || Promise.resolve();
  }
}
