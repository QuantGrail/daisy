import { Server as NetServer } from "node:net";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { log } from "../observe/log.ts";

/**
 * Process lifecycle (P1-02: one process, no leadership).
 *
 * `draining`: the process is about to exit (a restart for an update, or a
 * stop). Live sockets are closed with 1012 (Service Restart; clients
 * reconnect and resync from their cursors once the process is back), every
 * response tells the client to close the connection, and background sweeps
 * stop (`leading()`), so nothing new starts on the way out. What was the
 * standby / lease hand-over between two control-plane processes is gone:
 * Daisy restarts in place, and only once nothing runs (see
 * packages/daisy/src/update/restart.ts).
 */
export const RESTART_CLOSE = 1012;
export class Lifecycle {
  draining = false;
  /** Commit of the code this process runs (`.release`), null in a checkout. */
  release: string | null = null;
  /** May background work (sweeps, timers) run right now? */
  leading() {
    return !this.draining;
  }
  private hooks = new Set<() => void>();
  /** Run `fn` when draining starts. */
  onDrain(fn: () => void) {
    this.hooks.add(fn);
    return () => this.hooks.delete(fn);
  }
  beginDrain() {
    if (this.draining) return;
    this.draining = true;
    for (const fn of [...this.hooks])
      try {
        fn();
      } catch (e) {
        log.error("[drain]", (e as Error).message);
      }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Graceful HTTP drain for a Node server. Tracks requests in flight; on
 * `drain` it stops accepting, answers every
 * request still arriving on an open keep-alive connection with
 * `Connection: close` for `graceMs` (the proxy's idle connections are used
 * up and closed by the client, not under it), waits up to `timeoutMs` for
 * requests in flight, then closes the idle connections left.
 */
export function trackHttp(server: Server) {
  const active = new Set<ServerResponse>();
  let closing = false;
  const waiters = new Set<() => void>();
  const changed = () => {
    for (const w of [...waiters]) w();
  };
  server.prependListener(
    "request",
    (_req: IncomingMessage, res: ServerResponse) => {
      active.add(res);
      if (closing) res.shouldKeepAlive = false;
      res.once("close", () => {
        active.delete(res);
        changed();
      });
    },
  );
  const until = (pred: () => boolean, ms: number) =>
    new Promise<boolean>((resolve) => {
      if (pred()) return resolve(true);
      const timer = setTimeout(() => {
        waiters.delete(check);
        resolve(pred());
      }, ms);
      const check = () => {
        if (!pred()) return;
        clearTimeout(timer);
        waiters.delete(check);
        resolve(true);
      };
      waiters.add(check);
    });
  return {
    get inflight() {
      return active.size;
    },
    /** Stop accepting and wait for the requests in flight. */
    async drain(opts: { graceMs: number; timeoutMs: number }) {
      closing = true;
      for (const res of active)
        if (!res.headersSent) res.shouldKeepAlive = false;
      // net.Server#close: stop accepting without http.Server's immediate
      // closeIdleConnections (the grace below lets the client close them).
      if (server.listening) NetServer.prototype.close.call(server);
      await sleep(opts.graceMs);
      await until(() => active.size === 0, opts.timeoutMs);
      server.closeIdleConnections();
      return { stragglers: active.size };
    },
    /** Wait for the remaining requests. */
    settle(ms: number) {
      return until(() => active.size === 0, ms);
    },
  };
}
