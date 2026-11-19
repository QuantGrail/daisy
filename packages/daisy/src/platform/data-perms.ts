/**
 * P6-15 (ADR-158, P5N-1): the data directory's entries, owner-only all the
 * way down. The directory itself has been 0700 since P1-04, but what was
 * written inside under a 022 mask (`daisy start` from a shell before the
 * process set 077 — the database, its indexes, the Runner's identity
 * caches, plugins, sessions) kept group / other bits. Every start takes
 * those off once (store/open.ts; not inside keys/, whose files have their
 * own checks — a loose credential still refuses start-up, S-3); `daisy
 * doctor` reports what is left.
 *
 * The walk: lstat only, never following a link (links are left alone),
 * only entries of this account, nothing that is already tight, a file
 * with other hard links left alone too (its mode is shared with a name
 * outside the data directory). A change goes through the opened entry
 * (O_NOFOLLOW, the same inode checked again), so an entry swapped for a
 * link meanwhile is not followed. Group / other bits are taken off; the
 * owner's are kept (a plugin's program stays runnable). Bounded by an
 * entry count. No node:sqlite here: the command line loads it.
 */
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

export const DATA_PERMS_LIMITS = {
  /** Entries looked at in one walk (a data directory holds a few thousand). */
  maxEntries: 200_000,
  /** Paths named in a report. */
  examples: 5,
};

export interface PermsReport {
  /** Entries looked at (the root included). */
  checked: number;
  /** Ours, with group / other bits (before any change). */
  loose: number;
  /** Of those, tightened now (`fix`). */
  tightened: number;
  /** Not this account's (left alone). */
  foreign: number;
  /** Loose but left alone: another hard link shares the mode. */
  linked: number;
  /** Could not be read or changed. */
  failed: number;
  /** Stopped at maxEntries. */
  truncated: boolean;
  /** Up to `examples` loose entries, relative to the root. */
  examples: string[];
  /** Loose but left as they are on purpose (`leave`), relative to the root. */
  left: string[];
}

export interface PermsOptions {
  /** Take the bits off (start); false: only report (doctor). */
  fix: boolean;
  uid?: number;
  maxEntries?: number;
  /** A relative path whose contents are not looked into (its own mode still is). */
  opaque?: (rel: string) => boolean;
  /**
   * P6-16 review M1: a loose entry left as it is (reported in `left`): a
   * runner.json others can write — tightened, a file someone else could
   * write would become one Daisy trusts.
   */
  leave?: (rel: string, st: Stats) => boolean;  /** Tests: called just before a folder's names are read (to swap it for a link). */
  beforeReaddir?: (dir: string) => void;
}

const looseBits = (st: Stats) => (st.mode & 0o077) !== 0;

/** Take group / other off `path` through its opened entry; false when it could not. */
function tightenEntry(path: string, before: Stats, uid: number | undefined): boolean {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch {
    return false;
  }
  try {
    const st = fstatSync(fd);
    if (st.ino !== before.ino || st.dev !== before.dev) return false;
    // Review L1: still inside the folder walked (no link swapped in above it).
    if (realpathSync.native(dirname(path)) !== dirname(path)) return false;
    if (uid !== undefined && st.uid !== uid) return false;
    if (!st.isFile() && !st.isDirectory()) return false;
    fchmodSync(fd, st.mode & 0o700);
    return true;
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

/**
 * Walk `root` (POSIX). Windows: nothing to do here — the data directory's
 * protected DACL is inherited (P5-05); an empty report.
 */
export function ownerOnlyTree(given: string, o: PermsOptions): PermsReport {
  const r: PermsReport = { checked: 0, loose: 0, tightened: 0, foreign: 0, linked: 0, failed: 0, truncated: false, examples: [], left: [] };
  if (process.platform === "win32") return r;
  // Review M1: the data directory may itself be a link (DAISY_DATA pointing
  // at one): the walk starts from where it really is; below it, lstat only.
  let root: string;
  try {
    root = realpathSync.native(given);
  } catch {
    r.failed++;
    return r;
  }
  const uid = o.uid ?? process.getuid?.();
  const max = o.maxEntries ?? DATA_PERMS_LIMITS.maxEntries;
  const rel = (p: string) => relative(root, p).split(sep).join("/") || ".";
  const visit = (path: string): Stats | null => {
    if (r.checked >= max) {
      r.truncated = true;
      return null;
    }
    r.checked++;
    let st: Stats;
    try {
      st = lstatSync(path);
    } catch {
      r.failed++;
      return null;
    }
    if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory())) return null;
    if (uid !== undefined && st.uid !== uid) {
      r.foreign++;
      return st;
    }
    if (!looseBits(st)) return st;
    if (st.isFile() && st.nlink > 1) {
      r.linked++;
      return st;
    }
    r.loose++;
    if (r.examples.length < DATA_PERMS_LIMITS.examples) r.examples.push(rel(path));
    if (o.leave?.(rel(path), st)) r.left.push(rel(path));
    else if (o.fix) {
      if (tightenEntry(path, st, uid)) r.tightened++;
      else r.failed++;
    }
    return st;
  };
  const top = visit(root);
  if (!top?.isDirectory()) return r;
  const stack = [root];
  while (stack.length && !r.truncated) {
    const dir = stack.pop()!;
    let names: string[];
    try {
      // Review L1: a folder swapped for a link since it was looked at is
      // not walked into (it would lead outside the data directory).
      o.beforeReaddir?.(dir);
      if (realpathSync.native(dir) !== dir) throw new Error("moved");
      names = readdirSync(dir);
    } catch {
      r.failed++;
      continue;
    }
    for (const name of names) {
      const p = join(dir, name);
      const st = visit(p);
      if (r.truncated) break;
      // Review L1: not into another account's folder.
      if (st?.isDirectory() && (uid === undefined || st.uid === uid) && !(o.opaque && o.opaque(rel(p)))) stack.push(p);
    }
  }
  return r;
}

/**
 * The AI command lines' own homes inside the data directory
 * (`<identityRoot>/<nodeId>/<id>`, runner.json), relative to it: walked as
 * folders only — what a harness writes there follows the start's mask
 * inside a 0700 home (platform/umask.ts), and a home can hold a large cache.
 */
export function identityHomes(dataDir: string): Set<string> {
  const homes = new Set<string>();
  try {
    const cfg = JSON.parse(readFileSync(join(dataDir, "runner.json"), "utf8"));
    const node = String(cfg?.nodeId ?? "");
    const root = typeof cfg?.identityRoot === "string" && cfg.identityRoot ? cfg.identityRoot : join(dataDir, "runner");
    const at = relative(dataDir, join(root, node)).split(sep).join("/");
    if (/^[a-zA-Z0-9-]+$/.test(node) && at && !at.startsWith("..") && !isAbsolute(at))
      for (const id of readdirSync(join(root, node))) if (/^[a-zA-Z0-9-]+$/.test(id)) homes.add(`${at}/${id}`);
  } catch {}
  return homes;
}
