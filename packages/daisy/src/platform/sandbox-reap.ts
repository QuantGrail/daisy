/**
 * Codex 0.157.1 on Linux (measured, `workspace-write` sandbox):
 * `thread/backgroundTerminals/terminate` of a sandboxed command ends its
 * `bwrap` and answers `terminated:true`, but the command under bwrap is
 * reparented (to the user's systemd) and runs on. So, per terminal, the
 * Runner notes just before the terminate which bwrap(s) run that command,
 * and afterwards kills the direct children of those that the terminate
 * ended — nothing else. Pid + start time guard against reused pids.
 *
 * macOS (P5-04, ADR-140): the table is read with `ps` (no /proc). Codex's
 * sandbox there is Seatbelt (`sandbox-exec`), which applies its profile
 * and execs the command in place — no wrapper process stays between Codex
 * and the command, so no `bwrap` is ever found and the terminate itself
 * ends the command: nothing is left to reap, by construction, not by a
 * skipped check.
 */
import { commandLines, readProcTable } from "./proc-table.ts";

export interface Proc {
  parent: number;
  /** Start time (proc-table.ts: Linux clock ticks, macOS epoch ms). */
  start: string;
  comm: string;
  /** argv joined by spaces ("" when not read). */
  cmdline: string;
  zombie?: boolean;
}
export type ProcTable = Map<number, Proc>;
/** A bwrap running a terminal's command, as seen just before its terminate. */
export interface Sandbox {
  pid: number;
  start: string;
  /** Its direct children then (pid → start time). */
  children: Map<number, string>;
}

/** `pid` and everything under it in `table`. */
export function subtree(table: ProcTable, pid: number): Set<number> {
  const out = new Set<number>(),
    todo = [pid];
  while (todo.length) {
    const p = todo.pop()!;
    if (out.has(p) || !table.has(p)) continue;
    out.add(p);
    for (const [other, info] of table) if (info.parent === p) todo.push(other);
  }
  return out;
}
const alive = (table: ProcTable, pid: number, start: string) => {
  const p = table.get(pid);
  return !!p && p.start === start && !p.zombie;
};
/**
 * The bwraps under `root` whose subtree runs `command` (a terminal's
 * command as `thread/backgroundTerminals/list` reports it).
 */
export function sandboxesFor(
  table: ProcTable,
  root: number,
  command: string,
): Sandbox[] {
  const want = command.trim();
  if (!want) return [];
  const out: Sandbox[] = [];
  for (const pid of subtree(table, root)) {
    const b = table.get(pid)!;
    if (pid === root || b.comm !== "bwrap") continue;
    const under = subtree(table, pid);
    under.delete(pid);
    if (![...under].some((p) => table.get(p)!.cmdline.includes(want))) continue;
    const children = new Map<number, string>();
    for (const [c, info] of table)
      if (info.parent === pid) children.set(c, info.start);
    out.push({ pid, start: b.start, children });
  }
  return out;
}
/**
 * What to kill now: for each noted bwrap that is gone, its children of
 * then that still run (same start time), with everything under them now.
 * A bwrap still running (the terminate did not end it) is left alone.
 */
export function orphansToKill(noted: Sandbox[], now: ProcTable): number[] {
  const out = new Set<number>();
  for (const b of noted) {
    if (alive(now, b.pid, b.start)) continue;
    for (const [c, start] of b.children)
      if (alive(now, c, start)) for (const p of subtree(now, c)) out.add(p);
  }
  return [...out];
}

/** The process table now (cmdline read under `root` only); Linux /proc, macOS ps. */
export function readProcs(root?: number): ProcTable {
  const table: ProcTable = new Map();
  for (const [pid, r] of readProcTable())
    table.set(pid, {
      parent: r.ppid,
      start: r.start,
      comm: r.comm,
      cmdline: "",
      zombie: r.zombie,
    });
  if (root)
    for (const [pid, cmd] of commandLines([...subtree(table, root)]))
      table.get(pid)!.cmdline = cmd;
  return table;
}
/** Kill `pids` (SIGKILL); returns how many were signalled. */
export function killAll(pids: number[]): number {
  let n = 0;
  for (const pid of pids)
    try {
      process.kill(pid, "SIGKILL");
      n++;
    } catch {}
  return n;
}
