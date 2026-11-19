import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { log } from "../observe/log.ts";
import { lstartMs, ps, readProcTable, type ProcRow } from "./proc-table.ts";
/**
 * P1-02 / C-4: the process groups this process started (harness CLIs,
 * Daisy background commands, 「在终端执行」, the CLI terminal — each is
 * started with its own group, `detached`), written to a file in the data
 * directory. Normally each group is stopped by its owner. When this process
 * is killed (SIGKILL, a crash) nobody stops them: the next start reads the
 * file and ends what is still there.
 *
 * Only what is provably the group recorded is signalled:
 * - a group whose leader still runs: the leader's start time and command
 *   line must be the recorded ones (a pid reused by an unrelated process
 *   differs in either);
 * - a group whose leader exited but whose members live on: only members
 *   that started no earlier than the recorded leader (children of it);
 * - never this process's own group, nor the pid or group of any of its
 *   ancestors (a record that names them, by mistake or by hand, is skipped).
 */
let file: string | null = null;
const groups = new Map<number, { start: string; command: string }>();

export interface ProcInfo {
  /** Comparable start time: Linux clock ticks, elsewhere epoch ms. */
  start: string;
  pgid: number;
  ppid: number;
  command: string;
}

function linuxInfo(pid: number): ProcInfo | null {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    // After "(comm) ": state ppid pgrp … starttime is field 22 (index 19).
    const v = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
    let command = "";
    try {
      command = readFileSync(`/proc/${pid}/cmdline`, "utf8")
        .split("\0")
        .filter(Boolean)
        .join(" ");
    } catch {}
    return { start: v[19], ppid: Number(v[1]), pgid: Number(v[2]), command };
  } catch {
    return null;
  }
}

/** What identifies `pid` now (null: no such process). */
export function procInfo(pid: number): ProcInfo | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  // Windows (P5-05): the helper's process table — creation time, parent,
  // no group, the program's name for a command line.
  if (process.platform === "win32") {
    const r = readProcTable().get(pid);
    return r ? { start: r.start, pgid: 0, ppid: r.ppid, command: r.comm } : null;
  }
  if (process.platform === "linux") return linuxInfo(pid);
  try {
    const out = ps(["-o", "lstart=,pgid=,ppid=,command=", "-p", String(pid)])
      .trim()
      .split(/\s+/);
    if (out.length < 7) return null;
    const start = lstartMs(out);
    if (!start) return null;
    return {
      start,
      pgid: Number(out[5]),
      ppid: Number(out[6]),
      command: out.slice(7).join(" "),
    };
  } catch {
    return null;
  }
}

/** Every live process of group `pgid`, with its start time (/proc or ps, P5-04). */
function members(pgid: number): { pid: number; start: string }[] {
  return [...readProcTable().values()]
    .filter((r) => r.pgid === pgid && !r.zombie)
    .map((r) => ({ pid: r.pid, start: r.start }));
}

/**
 * This process, its group and every ancestor: never signalled. Read from
 * `table` when there is one (one `ps` on macOS instead of one per
 * ancestor).
 */
function protectedIds(table?: Map<number, ProcRow>): Set<number> {
  const out = new Set<number>([process.pid]);
  let pid = process.pid;
  for (let i = 0; i < 64 && pid > 1; i++) {
    const info = table ? table.get(pid) : procInfo(pid);
    if (!info) break;
    out.add(pid);
    if (info.pgid > 0) out.add(info.pgid);
    pid = info.ppid;
  }
  out.add(1);
  return out;
}

function save() {
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}`;
    writeFileSync(
      tmp,
      JSON.stringify({
        owner: process.pid,
        groups: [...groups].map(([pgid, g]) => ({ pgid, ...g })),
      }),
      { mode: 0o600 },
    );
    renameSync(tmp, file);
  } catch {}
}

/** Where they are written (main.ts: the data directory); null: nowhere. */
export function configureProcessGroups(path: string | null) {
  file = path;
  save();
}

/** A child started with its own group (its pid is the group id). */
export function trackGroup(pid: number | undefined) {
  if (!file || !pid || process.platform === "win32") return;
  const info = procInfo(pid);
  if (!info) return;
  groups.set(pid, { start: info.start, command: info.command });
  save();
  // Right after spawn the command line may still be an exec chain's first
  // step: a `#!/usr/bin/env node` CLI reads `/usr/bin/env node <script>`
  // until env has exec'd node (Linux CI, review P1-02). Read it again once
  // the chain has settled — same process (start time), its final command.
  for (const ms of [250, 2000]) {
    const t = setTimeout(() => {
      const g = groups.get(pid);
      if (!g) return;
      const now = procInfo(pid);
      if (now && now.start === g.start && now.command !== g.command) {
        g.command = now.command;
        save();
      }
    }, ms);
    (t as any).unref?.();
  }
}

/**
 * The recorded command line is this one: the same, or one an exec chain
 * turned into the other (`/usr/bin/env node x a` ↔ `node x a`: one ends
 * with the other at a word boundary). The start time is checked as well.
 */
export function sameCommand(recorded: string, now: string) {
  if (recorded === now) return true;
  const [long, short] =
    recorded.length > now.length ? [recorded, now] : [now, recorded];
  return short.length > 0 && long.endsWith(" " + short);
}
export function untrackGroup(pid: number | undefined) {
  if (pid && groups.delete(pid)) save();
}

const later = (a: string, b: string) => {
  const x = Number(a),
    y = Number(b);
  return Number.isFinite(x) && Number.isFinite(y) && x >= y;
};

/**
 * At start, before anything is started: end the groups a previous process
 * left (TERM, then KILL after `graceMs`). Returns the pids / groups
 * signalled (a group as its negative id).
 */
export async function sweepOrphans(path: string, graceMs = 1500) {
  let recorded: {
    groups?: { pgid: number; start: string; command?: string }[];
  };
  try {
    recorded = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  const keep = protectedIds();
  const targets: number[] = [];
  for (const g of recorded.groups ?? []) {
    if (!Number.isInteger(g.pgid) || g.pgid <= 1 || keep.has(g.pgid)) continue;
    const leader = procInfo(g.pgid);
    if (leader) {
      // The leader still runs: the very process recorded, or not ours.
      if (leader.start !== g.start) continue;
      if (
        typeof g.command === "string" &&
        !sameCommand(g.command, leader.command)
      )
        continue;
      targets.push(-g.pgid);
    } else {
      // The leader is gone, its children live on in its group: only those
      // started no earlier than it. (A group id reused by an unrelated
      // session whose leader exited too would pass this; that needs the
      // old leader to have died and the id to come round again between
      // two starts of this process — accepted, said in ADR-106.)
      for (const m of members(g.pgid))
        if (!keep.has(m.pid) && later(m.start, g.start)) targets.push(m.pid);
    }
  }
  const alive = (t: number) => {
    try {
      process.kill(t, 0);
      return true;
    } catch {
      return false;
    }
  };
  const sent = targets.filter((t) => {
    try {
      process.kill(t, "SIGTERM");
      return true;
    } catch {
      return false;
    }
  });
  if (sent.length) {
    const until = Date.now() + graceMs;
    while (Date.now() < until && sent.some(alive))
      await new Promise((r) => setTimeout(r, 50));
    for (const t of sent)
      try {
        process.kill(t, "SIGKILL");
      } catch {}
    log.info(
      `ended what the last process left behind (${sent.length} process group(s) / process(es); nobody reaped them when that process was killed)`,
    );
  }
  rmSync(path, { force: true });
  return sent;
}

/**
 * Windows (P5-05): a parent id is never cleared — a process whose parent
 * exited keeps naming it, and the id can come round to an unrelated
 * process. A child is only one if it started no earlier than the parent
 * (creation times are exact FILETIMEs there).
 */
function startedAfter(child: ProcRow, parent: ProcRow | undefined): boolean {
  if (!parent) return true;
  try {
    return BigInt(child.start) >= BigInt(parent.start);
  } catch {
    return false;
  }
}

/** One process of a tree noted for stopping (pid + start time: no reuse). */
export interface TreeProc {
  pid: number;
  start: string;
}
/**
 * C1-c: what stopping the group led by `root` must end — the group's
 * members and every descendant of `root` by parent (one that moved to a
 * group or session of its own, e.g. a daemonized child, is still under
 * it). Read the same way on Linux (/proc) and macOS (`ps`); Windows
 * (P5-05) has no groups — descendants by parent from the helper's `ps`
 * (the Job Object already ends them; this is the check and the fallback).
 * Never this process, its group or an ancestor.
 */
export function processTree(
  root: number | undefined,
  table: Map<number, ProcRow> = readProcTable(),
  platform: NodeJS.Platform = process.platform,
): TreeProc[] {
  if (!root) return [];
  const keep = protectedIds(table);
  const picked = new Set<number>();
  if (platform !== "win32")
    for (const [pid, i] of table) if (i.pgid === root) picked.add(pid);
  const todo = [root, ...picked];
  while (todo.length) {
    const p = todo.pop()!;
    if (table.has(p)) picked.add(p);
    for (const [pid, i] of table)
      if (i.ppid === p && !picked.has(pid) && (platform !== "win32" || startedAfter(i, table.get(p)))) {
        picked.add(pid);
        todo.push(pid);
      }
  }
  return [...picked]
    .filter((pid) => !keep.has(pid) && table.has(pid))
    .map((pid) => ({ pid, start: table.get(pid)!.start }));
}
/**
 * Signal the noted processes that are still the very ones noted (same
 * start time); returns how many were signalled.
 */
export function signalTree(tree: TreeProc[], signal: NodeJS.Signals) {
  if (!tree.length) return 0;
  const now = readProcTable();
  let n = 0;
  for (const t of tree)
    if (now.get(t.pid)?.start === t.start)
      try {
        process.kill(t.pid, signal);
        n++;
      } catch {}
  return n;
}

/**
 * How many of the noted processes still run (same start time, not a
 * zombie) — the wait after a stop (P5-04: /proc or ps alike).
 */
export function aliveInTree(tree: TreeProc[]): number {
  if (!tree.length) return 0;
  const now = readProcTable();
  return tree.filter((t) => {
    const r = now.get(t.pid);
    return !!r && r.start === t.start && !r.zombie;
  }).length;
}
