/**
 * Codex's own background commands in Daisy's 「后台」 list, each
 * stoppable alone. Codex 0.157.1 (experimental, research X12):
 * `thread/backgroundTerminals/list {threadId}` → `{data: [{itemId,
 * processId, command, cwd, osPid, cpuPercent, rssKb}]}` — a unified-exec
 * command still running after the item that started it (the model left
 * it running, or an interrupted turn's); there is no change notification,
 * so the list is re-read (at most every `REFRESH_MS`) whenever the Runner
 * asks what is pending, and right after a listed command's item completes. The
 * running turn's own commands are not listed (they are its tool items;
 * 「停止」 ends them).
 *
 * Stop = `thread/backgroundTerminals/terminate {threadId, processId}`. Under
 * `workspace-write` that ends only the bwrap, the sandboxed command keeps
 * running: the same reap as 「停止」 — the bwraps running that
 * command are noted before, and those that ended have their former
 * children killed (sandbox-reap.ts).
 */
import { turnT } from "./model-switch.ts";
import type {
  LiveActivity,
  LiveTimer,
} from "../../../contracts/src/index.ts";
import {
  killAll,
  orphansToKill,
  readProcs,
  sandboxesFor,
  type Sandbox,
} from "../platform/sandbox-reap.ts";

export const REFRESH_MS = 3000;
export type CodexTerminal = {
  threadId: string;
  itemId: string;
  processId: string;
  command: string;
  cwd?: string;
  cpuPercent?: number | null;
  rssKb?: number | null;
};
type Request = (method: string, params: any, ms: number) => Promise<any>;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const terminalId = (t: { threadId: string; processId: string }) =>
  `term:${t.threadId}:${t.processId}`;

export class CodexTerminals {
  private list: CodexTerminal[] = [];
  private readAt = 0;
  private reading: Promise<void> | null = null;
  private threads = new Set<string>();
  /** First seen (the list has no start time). */
  private since = new Map<string, number>();
  constructor(
    private opts: {
      request: Request;
      /** The session's thread (null: not started yet). */
      root: () => string | null;
      /** The running turn's own command items (thread → item ids). */
      running: () => Map<string, Set<string>> | null;
      /** The list changed: report soon. */
      changed: () => void;
      /** app-server's pid (the sandbox reap reads its process tree). */
      pid: () => number | undefined;
      /** Off: an older (or unknown) Codex — no such API, no polling. */
      enabled?: () => boolean;
    },
  ) {}
  /** A thread that ran commands (a subagent's too). */
  noteThread(id: string) {
    if (id) this.threads.add(id);
  }
  /** A command item ended: re-read when it was a listed one. */
  ended(threadId: string, itemId: string) {
    if (!this.list.some((t) => t.threadId === threadId && t.itemId === itemId))
      return;
    this.readAt = 0;
    void this.refresh();
  }
  refresh(): Promise<void> {
    if (this.opts.enabled && !this.opts.enabled()) return Promise.resolve();
    if (this.reading) return this.reading;
    const root = this.opts.root();
    if (!root) return Promise.resolve();
    this.reading = (async () => {
      const next: CodexTerminal[] = [];
      for (const threadId of new Set([root, ...this.threads])) {
        const r = await this.opts
          .request("thread/backgroundTerminals/list", { threadId }, 5000)
          .catch(() => null);
        // A subagent thread with nothing left running is not read again
        // (it is noted anew if it runs commands later).
        if (threadId !== root && r && !(r.data || []).length)
          this.threads.delete(threadId);
        for (const t of r?.data || [])
          if (t?.processId != null)
            next.push({
              threadId,
              itemId: String(t.itemId ?? ""),
              processId: String(t.processId),
              command: String(t.command ?? ""),
              ...(t.cwd ? { cwd: String(t.cwd) } : {}),
              cpuPercent: t.cpuPercent ?? null,
              rssKb: t.rssKb ?? null,
            });
      }
      const key = (l: CodexTerminal[]) =>
        l.map((t) => terminalId(t)).join("\n");
      const was = key(this.list);
      this.list = next;
      this.readAt = Date.now();
      const ids = new Set(next.map(terminalId));
      for (const id of [...this.since.keys()])
        if (!ids.has(id)) this.since.delete(id);
      for (const id of ids)
        if (!this.since.has(id)) this.since.set(id, Date.now());
      if (key(next) !== was) this.opts.changed();
    })().finally(() => {
      this.reading = null;
    });
    return this.reading;
  }
  /** Not the running turn's own. */
  private background() {
    const running = this.opts.running();
    return this.list.filter((t) => !running?.get(t.threadId)?.has(t.itemId));
  }
  pending(): LiveTimer[] {
    if (this.opts.enabled && !this.opts.enabled()) return [];
    if (Date.now() - this.readAt >= REFRESH_MS) void this.refresh();
    return this.background().map((t) => ({
      id: terminalId(t),
      kind: "task" as const,
      type: "codex_terminal",
      label: (t.command || turnT()("server-harness.codexBackground.command")).slice(0, 500),
      command: t.command.slice(0, 2000),
      since: this.since.get(terminalId(t)),
      stoppable: true,
    }));
  }
  /** CPU / memory as the list says (no output API for them). */
  activity(): LiveActivity[] {
    return this.background().map((t) => {
      const facts = [
        typeof t.cpuPercent === "number"
          ? `CPU ${Math.round(t.cpuPercent)}%`
          : "",
        typeof t.rssKb === "number"
          ? turnT()("server-harness.codexBackground.memory", { mb: Math.round(t.rssKb / 1024) })
          : "",
      ].filter(Boolean);
      return {
        id: terminalId(t),
        ...(facts.length ? { summary: facts.join(" · ") } : {}),
      };
    });
  }
  /** 「停止」 one: false when it is not (any longer) there. */
  async stop(id: string): Promise<boolean> {
    let t = this.list.find((x) => terminalId(x) === id);
    if (!t) {
      this.readAt = 0;
      await this.refresh();
      t = this.list.find((x) => terminalId(x) === id);
    }
    if (!t) return false;
    const root = this.opts.pid();
    const noted: Sandbox[] = root
      ? sandboxesFor(readProcs(root), root, t.command)
      : [];
    const r = await this.opts.request(
      "thread/backgroundTerminals/terminate",
      { threadId: t.threadId, processId: t.processId },
      5000,
    );
    if (noted.length)
      for (const wait of [300, 700]) {
        await delay(wait);
        killAll(orphansToKill(noted, readProcs()));
      }
    this.readAt = 0;
    await this.refresh();
    return r?.terminated !== false;
  }
}
