/**
 * P1-04 (ADR-102 decision 4, ADR-108): one Daisy per data directory. A lock
 * file in the directory names the process holding it (pid and its start
 * time); a second process refuses to start and says who holds it. A lock
 * whose process is gone — or whose pid now belongs to another process
 * (different start time) — is stale and taken over.
 */
import {
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { procInfo } from "../platform/process-groups.ts";
import { restrictToOwner } from "./open.ts";
import { ownerT } from "../platform/language.ts";

export const LOCK_FILE = "daisy.lock";

export interface LockHolder {
  pid: number;
  /** procInfo().start of that process (null where it cannot be read). */
  start: string | null;
  at: number;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
};

/** The process named in the lock still holds it. */
export function lockHeld(h: LockHolder): boolean {
  if (!Number.isInteger(h.pid) || h.pid <= 0 || !alive(h.pid)) return false;
  if (h.pid === process.pid) return true;
  const now = procInfo(h.pid)?.start ?? null;
  // A pid reused by another process: not the holder any more.
  return !(h.start && now && h.start !== now);
}

/**
 * Take the data directory's lock (creating the directory, 0700). Throws
 * with who holds it. Returns the release (also run on exit).
 */
export function acquireDataLock(dir: string): () => void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  restrictToOwner(dir);
  const file = join(dir, LOCK_FILE);
  const me: LockHolder = {
    pid: process.pid,
    start: procInfo(process.pid)?.start ?? null,
    at: Date.now(),
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(file, JSON.stringify(me) + "\n", {
        mode: 0o600,
        flag: "wx",
      });
      const release = () => {
        try {
          const h = JSON.parse(readFileSync(file, "utf8")) as LockHolder;
          if (h.pid === me.pid && h.at === me.at) rmSync(file, { force: true });
        } catch {}
        process.off("exit", release);
      };
      process.on("exit", release);
      return release;
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
    }
    let held: LockHolder | null = null,
      raw = "";
    try {
      raw = readFileSync(file, "utf8");
      held = JSON.parse(raw);
    } catch {
      // Unreadable or half written: treated as stale.
    }
    if (held && lockHeld(held))
      throw Error(ownerT(dir)("server-store.lock.held", { dir, pid: held.pid, at: new Date(held.at).toISOString() }));
    // Stale: moved aside atomically, so two starting processes cannot both
    // take it over.
    const aside = `${file}.stale.${process.pid}`;
    try {
      renameSync(file, aside);
      // Another process took it over in between: its fresh lock goes back.
      if (readFileSync(aside, "utf8") !== raw)
        try {
          linkSync(aside, file);
        } catch {}
      rmSync(aside, { force: true });
    } catch {}
  }
  throw Error(ownerT(dir)("server-store.lock.unavailable", { file }));
}
