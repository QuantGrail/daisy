/**
 * P5-04 (ADR-140): the process table, read the same way everywhere Daisy
 * needs it (stopping a harness's tree, the orphans a sandbox leaves, the
 * groups a killed Daisy left) — Linux from /proc, macOS from `ps` (macOS
 * has no /proc), Windows from the helper's `ps` (a Toolhelp snapshot,
 * P5-05 / ADR-141; no process groups there: `pgid` is 0).
 *
 * `start` tells a process from a later one with the same pid: Linux its
 * start time in clock ticks (/proc/<pid>/stat field 22); macOS `lstart`
 * as epoch ms (whole seconds — a pid reused within the same second by a
 * descendant of the same parent is not told apart; accepted, ADR-140).
 * Windows: the creation time as a FILETIME (100 ns ticks, exact); "0" for a
 * process this account may not query (another user's — never ours).
 * The kinds are never compared with each other.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { runHelper } from "./windows/helper.ts";

export interface ProcRow {
  pid: number;
  ppid: number;
  pgid: number;
  /** Comparable start time (see above). */
  start: string;
  /** The program's short name (Linux comm, macOS ucomm). */
  comm: string;
  /** A zombie: exited, not yet reaped. */
  zombie: boolean;
}

/** `ps` in a fixed locale and zone: its dates are comparable and parseable. */
export const ps = (args: string[]) =>
  execFileSync("ps", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  });

/** C-locale `lstart` (five words, UTC) → epoch ms as a string. */
export function lstartMs(words: string[]): string | null {
  const ms = Date.parse(words.slice(0, 5).join(" ") + " UTC");
  return Number.isFinite(ms) ? String(ms) : null;
}

/** One /proc/<pid>/stat line (Linux). */
export function parseStat(pid: number, raw: string): ProcRow {
  // After "(comm) ": state ppid pgrp … starttime is field 22 (index 19).
  const v = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
  return {
    pid,
    ppid: Number(v[1]),
    pgid: Number(v[2]),
    start: v[19]!,
    comm: raw.slice(raw.indexOf("(") + 1, raw.lastIndexOf(")")),
    zombie: v[0] === "Z",
  };
}

/** `ps -axo pid=,ppid=,pgid=,state=,lstart=,ucomm=` output (macOS). */
export function parsePs(text: string): Map<number, ProcRow> {
  const out = new Map<number, ProcRow>();
  for (const l of text.split("\n")) {
    const w = l.trim().split(/\s+/);
    // pid ppid pgid state + five lstart words + ucomm (may hold spaces).
    if (w.length < 9) continue;
    const start = lstartMs(w.slice(4, 9));
    const pid = Number(w[0]);
    if (!start || !Number.isInteger(pid)) continue;
    out.set(pid, {
      pid,
      ppid: Number(w[1]),
      pgid: Number(w[2]),
      start,
      comm: w.slice(9).join(" "),
      zombie: w[3]!.startsWith("Z"),
    });
  }
  return out;
}

/** The helper's `ps`: pid \t ppid \t FILETIME \t exe name per line (Windows). */
export function parseWinPs(text: string): Map<number, ProcRow> {
  const out = new Map<number, ProcRow>();
  for (const l of text.split(/\r?\n/)) {
    const [pid, ppid, start, ...name] = l.split("\t");
    if (!pid || !/^\d+$/.test(pid) || !ppid || !/^\d+$/.test(ppid) || !start || !/^\d+$/.test(start)) continue;
    // pid 0 (the idle process) is its own parent: never anyone's descendant.
    if (pid === "0") continue;
    out.set(Number(pid), {
      pid: Number(pid),
      ppid: Number(ppid),
      pgid: 0,
      start,
      comm: name.join("\t"),
      zombie: false,
    });
  }
  return out;
}

/** Every live process now (one read). Empty on an error (Windows: no helper). */
export function readProcTable(platform: NodeJS.Platform = process.platform): Map<number, ProcRow> {
  if (platform === "linux") {
    const out = new Map<number, ProcRow>();
    try {
      for (const n of readdirSync("/proc")) {
        if (!/^\d+$/.test(n)) continue;
        try {
          out.set(Number(n), parseStat(Number(n), readFileSync(`/proc/${n}/stat`, "utf8")));
        } catch {}
      }
    } catch {}
    return out;
  }
  if (platform === "win32") {
    try {
      return parseWinPs(runHelper(["ps"]));
    } catch {
      return new Map();
    }
  }
  try {
    return parsePs(ps(["-axo", "pid=,ppid=,pgid=,state=,lstart=,ucomm="]));
  } catch {
    return new Map();
  }
}

/** The helper's `cmdlines`: pid \t command line per line (Windows). */
export function parseWinCmdLines(text: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const l of text.split(/\r?\n/)) {
    const i = l.indexOf("\t");
    if (i > 0 && /^\d+$/.test(l.slice(0, i))) out.set(Number(l.slice(0, i)), l.slice(i + 1));
  }
  return out;
}

/**
 * The command lines of `pids` (argv joined by spaces; missing ones absent).
 * Windows (P5-05): the raw command line each process was started with
 * (the helper reads it, this account's processes only).
 */
export function commandLines(pids: number[], platform: NodeJS.Platform = process.platform): Map<number, string> {
  const out = new Map<number, string>();
  if (!pids.length) return out;
  if (platform === "win32") {
    try {
      return parseWinCmdLines(runHelper(["cmdlines", ...pids.map(String)]));
    } catch {
      return out;
    }
  }
  if (platform === "linux") {
    for (const pid of pids)
      try {
        out.set(pid, readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" "));
      } catch {}
    return out;
  }
  try {
    for (const l of ps(["-ww", "-o", "pid=,command=", "-p", pids.join(",")]).split("\n")) {
      const m = /^\s*(\d+)\s(.*)$/.exec(l);
      if (m) out.set(Number(m[1]), m[2]!);
    }
  } catch {}
  return out;
}

/** The short program name of `pid` (Linux comm, macOS ucomm), or null. */
export function processName(pid: number, platform: NodeJS.Platform = process.platform): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (platform === "win32") return readProcTable("win32").get(pid)?.comm.replace(/\.exe$/i, "") || null;
  try {
    if (platform === "linux") return readFileSync(`/proc/${pid}/comm`, "utf8").trim() || null;
    return ps(["-o", "ucomm=", "-p", String(pid)]).trim() || null;
  } catch {
    return null;
  }
}

/** `pid` and every descendant of it in `table` (by parent). */
export function descendants(table: Map<number, Pick<ProcRow, "ppid">>, pid: number): Set<number> {
  const children = new Map<number, number[]>();
  for (const [p, r] of table) {
    const list = children.get(r.ppid);
    if (list) list.push(p);
    else children.set(r.ppid, [p]);
  }
  const out = new Set<number>();
  const todo = [pid];
  while (todo.length) {
    const p = todo.pop()!;
    if (out.has(p) || !table.has(p)) continue;
    out.add(p);
    for (const c of children.get(p) ?? []) todo.push(c);
  }
  return out;
}
