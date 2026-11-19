import { turnT } from "../harness/model-switch.ts";
import { daisyEnv } from "../../../contracts/src/env.ts";
/**
 * Daisy's own file checkpoints for 「回退」 where the agent has
 * none (Codex: `thread/revert` rewinds the conversation only, research
 * X15). Same unified semantic as Claude Code's `rewind_files`: on a rewind
 * to before turn T, the files the AI's edit tool (`fileChange` items that
 * completed, apply_patch) changed in T and after go back, whole, to their
 * content before T; what commands or anyone else changed elsewhere is
 * listed, not restored.
 *
 * Per turn: a snapshot of the session's workspace before it (`pre`) and
 * after it (`post`) — manifests of content ids (git blob ids of the bytes
 * on disk, never through git's filters). The content is either in the
 * workspace's own git objects — only when the bytes on disk hash to the
 * index's blob id (so a smudged / eol-converted / LFS / encrypted file is
 * copied, never restored from the raw blob) — or in Daisy's store
 * (copied; per-file / per-snapshot caps; unchanged stat → reused).
 *
 * Safety (review r1): only paths inside the session's cwd (realpath; never
 * through a symlink, never `.git` or a nested repository); a read error is
 * "unknown", never "absent", and a file is deleted only when it provably
 * did not exist before (absent in a complete listing *and* created by the
 * edit tool); a file changed after the AI's edit (between turns, since the
 * last turn, or while restoring) is never overwritten; a rewound turn
 * without a checkpoint refuses the files up front; all restore content is
 * read and verified before the conversation is rewound; git runs without
 * hooks / fsmonitor / filters and never writes the repository. Store
 * under the Runner's realpath'd state root (`file-checkpoints/<session>`,
 * 0700 / 0600), capped by turns and bytes, sessions idle for `ttl` or
 * deleted on the control plane swept. No heavy synchronous work.
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import type { RunnerJob } from "../../../contracts/src/index.ts";
import { isFallback } from "../../../contracts/src/agent-capabilities.ts";

const gz = promisify(gzip),
  gunz = promisify(gunzip);
const MB = 1024 * 1024;
const num = (k: `DAISY_${string}`, d: number) => {
  const n = Number(daisyEnv(k));
  return Number.isFinite(n) && n > 0 ? n : d;
};
const limits = () => ({
  /** Total store per session (blobs + manifests). */
  bytes: num("DAISY_CODEX_CHECKPOINT_MB", 512) * MB,
  /** One file larger than this is not copied (listed as too large). */
  file: num("DAISY_CODEX_CHECKPOINT_FILE_MB", 8) * MB,
  /** New bytes one snapshot may copy. */
  snapshot: num("DAISY_CODEX_CHECKPOINT_SNAPSHOT_MB", 256) * MB,
  /** Turns kept per session (oldest dropped first). */
  turns: num("DAISY_CODEX_CHECKPOINT_TURNS", 30),
  /** Files in a workspace beyond which no checkpoint is made (said so). */
  files: num("DAISY_CODEX_CHECKPOINT_FILES", 20000),
  /** One snapshot's time budget (the turn waits for it). */
  ms: num("DAISY_CODEX_CHECKPOINT_MS", 15000),
  /** All sessions' checkpoints on this node (oldest sessions dropped first). */
  total: num("DAISY_CODEX_CHECKPOINT_TOTAL_MB", 4096) * MB,
  /** A session's checkpoints idle this long are removed. */
  ttl: num("DAISY_CODEX_CHECKPOINT_TTL_DAYS", 14) * 86400_000,
});
/** Not walked when the workspace is not a git work tree. */
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  ".mypy_cache",
  ".pytest_cache",
  ".next",
  ".turbo",
  "target",
]);

let root: string | null = null,
  state: string | null = null,
  /** Of these session ids, the ones the control plane no longer has. */
  goneOf: ((ids: string[]) => Promise<string[]>) | null = null,
  /** Sessions online / running here: never swept by age. */
  keptOf: (() => string[]) | null = null;
let lastSweep = 0;
/**
 * The Runner's state root (null: checkpoints off, e.g. adapters in unit
 * tests); `gone`: asks the control plane which sessions were deleted.
 */
export function configureFileCheckpoints(o: {
  stateRoot: string | null;
  gone?: (ids: string[]) => Promise<string[]>;
  kept?: () => string[];
}) {
  let s = o.stateRoot ? resolve(o.stateRoot) : null;
  // Review L2: realpath'd, so the exclusion holds through symlinks.
  if (s)
    try {
      s = realpathOf(s);
    } catch {}
  state = s;
  root = s ? join(s, "file-checkpoints") : null;
  goneOf = o.gone ?? null;
  keptOf = o.kept ?? null;
  lastSweep = 0;
  manifests.clear();
  // Re-review: a store made by an older build gets the private modes too.
  if (root) void tighten(root);
}
/** DAISY_CODEX_FILE_CHECKPOINTS=0 turns them off (reported `rewind.files: none`). */
export const fileCheckpointsOn = () =>
  daisyEnv("DAISY_CODEX_FILE_CHECKPOINTS") !== "0";
const active = () => !!root && fileCheckpointsOn();

/** The sessions' turns that get checkpoints: Codex, writable, not a sidecar. */
export function checkpointsFor(job: RunnerJob, reported: any): boolean {
  return (
    active() &&
    job.session.agent === "codex" &&
    isFallback(reported?.rewind?.files) &&
    !job.operation &&
    !job.session.sidecar &&
    !["read-only", "snapshot"].includes(job.session.workspaceMode || "")
  );
}

/** A file's content id: the git blob id of its bytes (no filters). */
export const blobId = (b: Buffer) =>
  createHash("sha1").update(`blob ${b.length}\0`).update(b).digest("hex");

interface Entry {
  id: string;
  /** repo: the workspace's git objects hold exactly these bytes; store: Daisy's copy. */
  src: "repo" | "store";
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
}
export interface Manifest {
  v: 2;
  git: boolean;
  files: Record<string, Entry>;
  /** Listed but no content: too-large / symlink / budget / unreadable / not-file. */
  skipped: Record<string, string>;
  /** Folders that could not be read: nothing under them is known. */
  unknownDirs: string[];
  /** Nested repositories / submodules: excluded. */
  nested: string[];
  /**
   * Re-review M-1: what git ignored *then* (files, and folders as
   * `dir`), so absence is judged by the rules of that time; null: not
   * known (too many, or an older manifest) — nothing absent is provable.
   */
  ignored?: string[] | null;
}
interface Change {
  path: string;
  kind: "add" | "delete" | "update";
  /**
   * Review (followups-1109): the destination of a move — its source path
   * in the workspace, or null when the source was outside it. Deleting the
   * destination is then only right if the source comes back.
   */
  movedFrom?: string | null;
}
interface TurnRecord {
  turnId: string;
  jobIds: string[];
  at: number;
  pre: string | null;
  post: string | null;
  changed: Change[];
  /** fileChange paths outside the workspace (never touched). */
  outside: string[];
  error?: string;
}
interface Index {
  v: 2;
  sid: string;
  cwd: string;
  turns: TurnRecord[];
}
/** The newest record of `turnId` (-1: none). */
const lastAt = (turns: TurnRecord[], turnId: string) => {
  for (let i = turns.length - 1; i >= 0; i--)
    if (turns[i].turnId === turnId) return i;
  return -1;
};
const safeKey = (s: string) =>
  s.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120) || "_";
const sessionDir = (sid: string) => join(root!, safeKey(sid));
const blobPath = (dir: string, id: string) =>
  join(dir, "blobs", id.slice(0, 2), id);
const manifestPath = (dir: string, name: string) =>
  join(dir, "m", name + ".json.gz");
/** Review L1: Daisy's store is private (0700 folders, 0600 files). */
async function storeWrite(path: string, data: Buffer | string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, data, { mode: 0o600 });
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}
async function loadIndex(dir: string): Promise<Index | null> {
  try {
    const x = JSON.parse(await readFile(join(dir, "index.json"), "utf8"));
    return x?.v === 2 && Array.isArray(x.turns) ? x : null;
  } catch {
    return null;
  }
}
const saveIndex = (dir: string, index: Index) =>
  storeWrite(join(dir, "index.json"), JSON.stringify(index));
/** Parsed manifests (immutable, content-named): each read once. */
const manifests = new Map<string, Manifest>();
async function loadManifest(
  dir: string,
  name: string | null,
): Promise<Manifest | null> {
  if (!name) return null;
  const path = manifestPath(dir, name);
  const hit = manifests.get(path);
  if (hit) return hit;
  try {
    const m = JSON.parse((await gunz(await readFile(path))).toString());
    if (m?.v !== 2) return null;
    if (manifests.size > 200) manifests.delete(manifests.keys().next().value!);
    manifests.set(path, m);
    return m;
  } catch {
    return null;
  }
}
async function saveManifest(dir: string, m: Manifest) {
  const json = JSON.stringify(m),
    name = createHash("sha256").update(json).digest("hex").slice(0, 40);
  if (!existsSync(manifestPath(dir, name)))
    await storeWrite(manifestPath(dir, name), await gz(json));
  manifests.set(manifestPath(dir, name), m);
  return name;
}
/** 0700 folders / 0600 files under the store (background, best effort). */
async function tighten(d: string): Promise<void> {
  try {
    await chmod(d, 0o700);
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await tighten(p);
      else if (e.isFile()) await chmod(p, 0o600).catch(() => {});
    }
  } catch {}
}
/** A removed session folder's parsed manifests go too. */
async function removeSession(d: string) {
  await rm(d, { recursive: true, force: true });
  for (const k of [...manifests.keys()])
    if (k.startsWith(d + sep)) manifests.delete(k);
}
/** One session's index changes, one after another. */
const chains = new Map<string, Promise<unknown>>();
function serial<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const next = (chains.get(dir) ?? Promise.resolve()).then(fn, fn);
  chains.set(
    dir,
    next.catch(() => {}),
  );
  return next;
}

/**
 * Review M4: git only reads — no hooks, no fsmonitor command, no
 * untracked cache or index writes, no system config, no filters (nothing
 * here runs one: no `ls-files -m`, no `cat-file --filters`).
 */
const GIT_SAFE = [
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "core.splitIndex=false",
];
const gitEnv = () => {
  const env = {} as NodeJS.ProcessEnv;
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !/^GIT_/.test(k)) env[k] = v;
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  // Re-review: git's warnings are parsed — in English.
  delete env.LANGUAGE;
  env.LC_ALL = "C";
  return env;
};
const git = (cwd: string, args: string[], ms: number) =>
  new Promise<{ out: Buffer; err: string; code: number }>((ok, fail) =>
    execFile(
      "git",
      [...GIT_SAFE, ...args],
      {
        cwd,
        env: gitEnv(),
        timeout: Math.max(1000, ms),
        maxBuffer: 1024 * MB,
        encoding: "buffer",
      },
      (e: any, out, err) => {
        if (e && typeof e.code !== "number") return fail(e);
        ok({
          out: out as Buffer,
          err: String(err || ""),
          code: e ? e.code : 0,
        });
      },
    ),
  );
/** Zero-width / bidi / other ignorable code points (`.git` look-alikes). */
const IGNORABLE = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ￰-￸]/;
/** A path never part of a snapshot nor restored (review L5). */
export const forbidden = (rel: string) =>
  IGNORABLE.test(rel) ||
  rel.split("/").some((c) => {
    const x = c
      .normalize("NFC")
      .toLowerCase()
      .replace(/[. ]+$/, "");
    return x === ".git" || x === "git~1";
  });
const under = (rel: string, dirs: string[]) =>
  dirs.some((d) => d === "" || rel === d || rel.startsWith(d + "/"));

/**
 * P5-05: Windows' temp and profile folders can be reached by an 8.3 short
 * name (RUNNER~1); only the native realpath gives the long one, which is
 * what `canonical` compares with. Elsewhere unchanged.
 */
const realpathOf = (p: string) =>
  process.platform === "win32" ? realpathSync.native(p) : realpathSync(p);
class TooBroad extends Error {}
/** Review M6: workspaces too broad to snapshot (said so on the turn). */
function tooBroad(cwd: string) {
  const r = resolve(cwd);
  // A drive root (C:\\) is a root too (P5-05).
  if (r === "/" || r === parse(r).root || r === resolve(homedir()))
    throw new TooBroad(turnT()("server-turns.checkpoint.tooBroad"));
}

/**
 * The workspace as content ids. `store`: copy what is not in its git
 * objects (false: ids only — the "now" of a rewind plan).
 */
export async function snapshot(
  cwd: string,
  dir: string,
  prev: Manifest | null,
  o: {
    store?: boolean;
    deadline?: number;
    /**
     * paths read even when git ignores them now — the
     * AI's edits of paths provably absent before its turn (`provablyAbsent`).
     */
    extra?: Iterable<string>;
  } = {},
): Promise<Manifest> {
  tooBroad(cwd);
  const lim = limits(),
    deadline = o.deadline ?? Date.now() + lim.ms,
    store = o.store !== false;
  const left = () => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw Error(turnT()("server-turns.checkpoint.timeout"));
    return ms;
  };
  // Daisy's own state is never part of it (it may sit inside a workspace).
  const own = [state, root, dir]
    .filter(Boolean)
    .map((r) => relative(cwd, r!))
    .filter((r) => r && !r.startsWith("..") && !isAbsolute(r));
  const ours = (rel: string) => under(rel, own);
  const m: Manifest = {
    v: 2,
    git: false,
    files: {},
    skipped: {},
    unknownDirs: [],
    nested: [],
    ignored: null,
  };
  let budget = lim.snapshot;
  /** Disk truth: absent only on ENOENT; any other error → unreadable. */
  const fromDisk = async (rel: string, indexId?: string) => {
    if (forbidden(rel) || ours(rel)) return;
    const abs = join(cwd, rel);
    let st;
    try {
      st = await lstat(abs);
    } catch (e: any) {
      if (e?.code !== "ENOENT" && e?.code !== "ENOTDIR")
        m.skipped[rel] = "unreadable";
      return;
    }
    if (st.isSymbolicLink()) return void (m.skipped[rel] = "symlink");
    if (!st.isFile()) return void (m.skipped[rel] = "not-file");
    if (st.size > lim.file) return void (m.skipped[rel] = "too-large");
    const p = prev?.files[rel];
    if (
      p &&
      p.size === st.size &&
      p.mtimeMs === st.mtimeMs &&
      p.ctimeMs === st.ctimeMs &&
      p.ino === st.ino &&
      (p.src === "repo"
        ? p.id === indexId
        : !store || existsSync(blobPath(dir, p.id)))
    ) {
      m.files[rel] = { ...p, mode: st.mode & 0o777 };
      return;
    }
    left();
    let data: Buffer;
    try {
      data = await readFile(abs);
    } catch {
      return void (m.skipped[rel] = "unreadable");
    }
    const id = blobId(data);
    // Review H1: the repository's blob only when it *is* these bytes.
    const src = indexId === id ? "repo" : "store";
    if (src === "store" && store && !existsSync(blobPath(dir, id))) {
      if (data.length > budget) return void (m.skipped[rel] = "budget");
      budget -= data.length;
      await storeWrite(blobPath(dir, id), data);
    }
    m.files[rel] = {
      id,
      src,
      mode: st.mode & 0o777,
      size: st.size,
      mtimeMs: st.mtimeMs,
      ctimeMs: st.ctimeMs,
      ino: st.ino,
    };
  };
  const inside = await git(
    cwd,
    ["rev-parse", "--is-inside-work-tree"],
    left(),
  ).catch(() => null);
  if (inside?.code === 0 && inside.out.toString().trim() === "true") {
    m.git = true;
    const listed = await git(cwd, ["ls-files", "-z", "-s"], left());
    if (listed.code !== 0) throw Error(turnT()("server-turns.checkpoint.gitFailed"));
    const index = new Map<string, string | undefined>();
    for (const line of listed.out.toString("utf8").split("\0")) {
      const x = /^(\d+) ([0-9a-f]+) (\d)\t(.+)$/s.exec(line);
      if (!x) continue;
      const [, mode, id, stage, rel] = x;
      if (mode === "160000") m.nested.push(rel);
      // A conflicted path: no single blob — copied from disk.
      else if (stage !== "0") index.set(rel, undefined);
      else if (!index.has(rel)) index.set(rel, id);
    }
    const others = await git(
      cwd,
      ["ls-files", "-z", "-o", "--exclude-standard"],
      left(),
    );
    if (others.code !== 0) throw Error(turnT()("server-turns.checkpoint.gitFailed"));
    // Review H2: a folder git could not read is unknown, not empty.
    for (const x of others.err.matchAll(/could not open directory '([^']*)'/g))
      m.unknownDirs.push(x[1].replace(/\/+$/, ""));
    for (const rel of others.out.toString("utf8").split("\0")) {
      if (!rel) continue;
      if (rel.endsWith("/")) m.nested.push(rel.replace(/\/+$/, ""));
      else if (!index.has(rel)) index.set(rel, undefined);
    }
    // Re-review M-1: the ignored paths of this moment (an ignored file
    // that exists is not "absent" even if the rules change later).
    const ign = await git(
      cwd,
      ["ls-files", "-z", "-o", "-i", "--exclude-standard", "--directory"],
      left(),
    );
    if (ign.code === 0) {
      const list = ign.out
        .toString("utf8")
        .split("\0")
        .filter(Boolean)
        .map((x) => x.replace(/\/+$/, ""))
        // Review (followups-1109 A): the cwd itself ignored (an ignored
        // folder of a repo) is listed as `./` — everything under it.
        .map((x) => (x === "." || x === "./" ? "" : x));
      m.ignored = list.length <= lim.files ? list : null;
    }
    // an ignored path already known (an AI-created one,
    // via `extra`) stays known, so later turns can verify it; never a
    // pre-existing ignored file (only `extra` brings one in).
    for (const rel of [...Object.keys(prev?.files ?? {}), ...(o.extra ?? [])])
      if (!index.has(rel)) index.set(rel, undefined);
    if (index.size > lim.files)
      throw new TooBroad(
        turnT()("server-turns.checkpoint.tooMany", { n: lim.files }),
      );
    for (const [rel, id] of index) {
      if (under(rel, m.nested)) continue;
      await fromDisk(rel, id);
    }
    return m;
  }
  // Not a git work tree: walk it (well-known dependency / cache folders out).
  const queue = [""];
  let count = 0;
  while (queue.length) {
    const d = queue.shift()!;
    left();
    let list;
    try {
      list = await readdir(join(cwd, d), { withFileTypes: true });
    } catch (e: any) {
      if (!d) throw e;
      m.unknownDirs.push(d);
      continue;
    }
    if (d && list.some((e) => e.name === ".git")) {
      m.nested.push(d);
      continue;
    }
    for (const e of list) {
      const rel = d ? `${d}/${e.name}` : e.name;
      if (ours(rel) || forbidden(rel)) continue;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) queue.push(rel);
        continue;
      }
      if (++count > lim.files)
        throw new TooBroad(
          turnT()("server-turns.checkpoint.tooMany", { n: lim.files }),
        );
      await fromDisk(rel);
    }
  }
  return m;
}
/**
 * Absence is judged by the rules of
 * that snapshot only — not ignored *then* (its recorded list) means it
 * would have been listed had it existed; no list (an older manifest, or
 * too many) → not provable. An ignored file that existed is in that list,
 * so it is never "absent" whatever the rules are now.
 */
function covered(m: Manifest, rel: string): boolean {
  if (forbidden(rel)) return false;
  if (!m.git)
    return !rel
      .split("/")
      .slice(0, -1)
      .some((c) => SKIP_DIRS.has(c));
  return Array.isArray(m.ignored) && !under(rel, m.ignored);
}
/**
 * Review (followups-1109 B / C): `rel` names its file canonically — its
 * folder is its own realpath (no symlinked folder, no case alias of a
 * folder) and the file's name is exactly one of that folder's entries (no
 * case alias such as `.ENV` for `.env`). Only such a path can be proven
 * absent from a listing, or deleted. `cwd` is a realpath. False on errors.
 */
export async function canonical(cwd: string, rel: string): Promise<boolean> {
  if (!rel || forbidden(rel)) return false;
  const abs = join(cwd, rel),
    dir = dirname(abs);
  try {
    if (realpathSync.native(dir) !== dir) return false;
    return (await readdir(dir)).includes(basename(abs));
  } catch {
    return false;
  }
}
/**
 * Review (followups-1109): git's own word as a guard before a delete — 0
 * ignored / 1 not ignored are both fine (absence was proven by the rules
 * of the snapshot); anything else (beyond a symlink, outside the repo, an
 * error) → not provable.
 */
async function gitDecides(cwd: string, rel: string): Promise<boolean> {
  const r = await git(
    cwd,
    ["check-ignore", "-q", "--no-index", "--", rel],
    5000,
  ).catch(() => null);
  return r?.code === 0 || r?.code === 1;
}
/** Provably did not exist when `m` was taken (a complete listing says so). */
const provablyAbsent = (m: Manifest, rel: string) => {
  const s = stateIn(m, rel);
  return !("unknown" in s) && s.id === null;
};
/** What `m` says about `rel`: its content id, absent (null), or unknown (why). */
type State = { id: string | null; entry?: Entry } | { unknown: string };
function stateIn(m: Manifest | null, rel: string): State {
  if (!m) return { unknown: "no-snapshot" };
  if (under(rel, m.nested)) return { unknown: "nested-repo" };
  const e = m.files[rel];
  if (e) return { id: e.id, entry: e };
  if (m.skipped[rel]) return { unknown: m.skipped[rel] };
  if (under(rel, m.unknownDirs)) return { unknown: "unreadable" };
  return covered(m, rel) ? { id: null } : { unknown: "no-snapshot" };
}
const asyncFilter = async <T>(xs: T[], f: (x: T) => Promise<boolean>) => {
  const out: T[] = [];
  for (const x of xs) if (await f(x)) out.push(x);
  return out;
};
/** The file now (review H2: any error is unknown, only ENOENT absent). */
async function currentState(abs: string): Promise<State> {
  let st;
  try {
    st = await lstat(abs);
  } catch (e: any) {
    return e?.code === "ENOENT" || e?.code === "ENOTDIR"
      ? { id: null }
      : { unknown: "unreadable" };
  }
  if (st.isSymbolicLink()) return { unknown: "symlink" };
  if (!st.isFile()) return { unknown: "not-file" };
  if (st.size > limits().file) return { unknown: "too-large" };
  try {
    return { id: blobId(await readFile(abs)) };
  } catch {
    return { unknown: "unreadable" };
  }
}

/** A path of a fileChange, relative to the workspace (null: outside it). */
export function workspacePath(cwd: string, path: string): string | null {
  if (typeof path !== "string" || !path || path.includes("\0")) return null;
  const real = realpathOf(cwd);
  const abs = isAbsolute(path) ? resolve(path) : resolve(real, path);
  for (const base of new Set([resolve(cwd), real])) {
    const rel = relative(base, abs);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue;
    // Its folder may be a symlink out of the workspace.
    let anc = dirname(join(real, rel));
    while (!existsSync(anc) && anc.length > real.length) anc = dirname(anc);
    try {
      const r = relative(real, realpathOf(anc));
      if (r.startsWith("..") || isAbsolute(r)) return null;
    } catch {
      return null;
    }
    const out = rel.split(sep).join("/");
    return forbidden(out) ? null : out;
  }
  return null;
}

/** One Codex turn's checkpoint, driven by the adapter. */
export class TurnCheckpoint {
  private changed = new Map<string, Change>();
  private outside = new Set<string>();
  private turnId: string | undefined;
  private constructor(
    private readonly sid: string,
    private readonly cwd: string,
    private readonly dir: string,
    private readonly jobId: string,
    private readonly pre: string | null,
    /** No checkpoint for this turn: why (said on the turn and on a rewind). */
    readonly error?: string,
    /**
     * P5-04: the cwd as the harness was given it (`cwd` is its realpath).
     * The harness reports paths under this one — on macOS a temporary or
     * symlinked folder (/var → /private/var) differs from its realpath.
     */
    private readonly given: string = cwd,
  ) {}
  /** Before turn/start: the workspace as it is now (never throws). */
  static async begin(job: RunnerJob, cwd: string, reported: any) {
    if (!checkpointsFor(job, reported)) return null;
    const dir = sessionDir(job.session.id);
    void sweep(dir);
    try {
      const real = realpathOf(cwd);
      const index = await loadIndex(dir);
      const last = index?.cwd === real ? index.turns.at(-1) : undefined;
      const prev = await loadManifest(dir, last?.post ?? last?.pre ?? null);
      const m = await snapshot(real, dir, prev);
      return new TurnCheckpoint(
        job.session.id,
        real,
        dir,
        job.id,
        await saveManifest(dir, m),
        undefined,
        resolve(cwd),
      );
    } catch (e: any) {
      return new TurnCheckpoint(
        job.session.id,
        cwd,
        dir,
        job.id,
        null,
        String(e?.message || e).slice(0, 200),
      );
    }
  }
  started(turnId: string | undefined) {
    if (turnId) this.turnId = turnId;
  }
  /**
   * A `fileChange` item that completed (review M2: a declined / failed
   * patch changed nothing — the adapter passes completed ones only).
   */
  fileChange(item: any) {
    if (item?.status !== "completed") return;
    for (const c of Array.isArray(item?.changes) ? item.changes : []) {
      const kind = c?.kind?.type;
      const k = kind === "add" || kind === "delete" ? kind : "update";
      const add = (
        path: string,
        kind: Change["kind"],
        movedFrom?: string | null,
      ): string | null => {
        let rel: string | null = null;
        try {
          rel = workspacePath(this.given, path);
        } catch {}
        if (rel === null) {
          if (typeof path === "string" && path) this.outside.add(path);
          return null;
        }
        if (!this.changed.has(rel))
          this.changed.set(rel, {
            path: rel,
            kind,
            ...(movedFrom !== undefined ? { movedFrom } : {}),
          });
        return rel;
      };
      const from = add(c?.path, k);
      if (k === "update" && c?.kind?.move_path)
        add(c.kind.move_path, "add", from);
    }
  }
  /** After the turn (also stopped / failed): the workspace as the AI left it. */
  async end() {
    if (!this.turnId) return;
    await serial(this.dir, async () => {
      let post: string | null = null,
        error = this.error;
      if (this.pre)
        try {
          const pre = await loadManifest(this.dir, this.pre);
          post = await saveManifest(
            this.dir,
            await snapshot(this.cwd, this.dir, pre, {
              // what the AI's edit tool created where
              // nothing was (dist/x.js, a new .env) is read even if
              // ignored, so a rewind can verify and delete it.
              extra: pre
                ? await asyncFilter(
                    [...this.changed.keys()],
                    async (rel) =>
                      provablyAbsent(pre, rel) &&
                      (await canonical(this.cwd, rel)),
                  )
                : [],
            }),
          );
        } catch (e: any) {
          error = String(e?.message || e).slice(0, 200);
        }
      const index: Index = (await loadIndex(this.dir)) ?? {
        v: 2,
        sid: this.sid,
        cwd: this.cwd,
        turns: [],
      };
      if (index.cwd !== this.cwd) {
        index.cwd = this.cwd;
        index.turns = [];
      }
      const last = index.turns.at(-1),
        same = last?.turnId === this.turnId ? last : undefined;
      if (same) {
        // Codex ran this job in a turn still active: one turn, merged.
        same.jobIds.push(this.jobId);
        same.post = post;
        for (const c of this.changed.values())
          if (!same.changed.some((x) => x.path === c.path))
            same.changed.push(c);
        same.outside = [...new Set([...same.outside, ...this.outside])];
        if (error) same.error = error;
      } else
        index.turns.push({
          turnId: this.turnId!,
          jobIds: [this.jobId],
          at: Date.now(),
          pre: this.pre,
          post,
          changed: [...this.changed.values()],
          outside: [...this.outside],
          ...(error ? { error } : {}),
        });
      await prune(this.dir, index);
    }).catch(() => {});
  }
}
/** Referenced manifests / blobs only; oldest turns out over the caps. */
async function prune(dir: string, index: Index) {
  const lim = limits();
  while (index.turns.length > lim.turns) index.turns.shift();
  for (;;) {
    await saveIndex(dir, index);
    const names = new Set<string>(),
      blobs = new Set<string>();
    for (const t of index.turns)
      for (const n of [t.pre, t.post]) if (n) names.add(n);
    for (const n of names)
      for (const e of Object.values((await loadManifest(dir, n))?.files || {}))
        if (e.src === "store") blobs.add(e.id);
    let size = 0;
    for (const sub of ["m", "blobs"]) {
      const walk = async (d: string) => {
        let list;
        try {
          list = await readdir(d, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of list) {
          const p = join(d, e.name);
          if (e.isDirectory()) await walk(p);
          else {
            const keep =
              sub === "m"
                ? names.has(e.name.replace(/\.json\.gz$/, ""))
                : blobs.has(e.name);
            if (!keep) {
              await rm(p, { force: true });
              manifests.delete(p);
            } else size += (await stat(p).catch(() => null))?.size ?? 0;
          }
        }
      };
      await walk(join(dir, sub));
    }
    if (size <= lim.bytes || index.turns.length <= 1) return;
    index.turns.shift();
  }
}
const du = async (d: string): Promise<number> => {
  let n = 0;
  try {
    for (const e of await readdir(d, { withFileTypes: true }))
      n += e.isDirectory()
        ? await du(join(d, e.name))
        : ((await stat(join(d, e.name)).catch(() => null))?.size ?? 0);
  } catch {}
  return n;
};
/**
 * Sessions idle past the ttl or deleted on the control plane (review
 * L1), then the oldest over the node's total (at most hourly, in the
 * background; `keep`: the session about to snapshot).
 */
export async function sweep(keep?: string, force = false) {
  if (!root || (!force && Date.now() - lastSweep < 3600_000)) return;
  lastSweep = Date.now();
  try {
    const lim = limits(),
      dirs: { d: string; sid: string; at: number }[] = [];
    // Re-review: sessions online / running here are never swept.
    const kept = new Set((keptOf?.() ?? []).map((sid) => sessionDir(sid)));
    if (keep) kept.add(keep);
    for (const name of await readdir(root).catch(() => [] as string[])) {
      const d = join(root, name);
      const st =
        (await stat(join(d, "index.json")).catch(() => null)) ??
        (await stat(d).catch(() => null));
      const sid = (await loadIndex(d))?.sid ?? name;
      if (!kept.has(d) && Date.now() - (st?.mtimeMs ?? 0) > lim.ttl)
        await removeSession(d);
      else dirs.push({ d, sid, at: st?.mtimeMs ?? 0 });
    }
    const gone = goneOf
      ? new Set(
          await goneOf(
            dirs.filter((x) => !kept.has(x.d)).map((x) => x.sid),
          ).catch(() => [] as string[]),
        )
      : new Set<string>();
    const left: { d: string; at: number; size: number }[] = [];
    for (const x of dirs)
      if (gone.has(x.sid) && !kept.has(x.d)) await removeSession(x.d);
      else left.push({ ...x, size: await du(x.d) });
    let total = left.reduce((n, x) => n + x.size, 0);
    for (const x of left.sort((a, b) => a.at - b.at)) {
      if (total <= lim.total) break;
      if (kept.has(x.d)) continue;
      await removeSession(x.d);
      total -= x.size;
    }
  } catch {}
}

export interface RewindFilesPlan {
  /** Not possible: unsupported / no-checkpoint / nothing. */
  reason?: string;
  /** Review L4: rewound turns without a checkpoint (refuses the files). */
  missing: { turnId: string; why: string }[];
  /**
   * Re-review M-2: AI-edited files that cannot be restored (content
   * missing / unknown) — refuses the files (never a partial restore).
   * Outside the workspace / in a nested repository: by design, said only.
   */
  unrestorable: { path: string; why: string }[];
  restore: {
    path: string;
    /** null: delete it (it did not exist). */
    data: Buffer | null;
    mode: number;
    /** What it is now (review M1: re-checked right before the write). */
    expect: string | null;
  }[];
  conflicts: { path: string; why: string }[];
  notRestored: { path: string; why: string }[];
  /** Changed since then, not by the AI's edit tool (not restored). */
  others: string[];
  othersCount: number;
  cwd: string;
  sid: string;
  dir: string;
}
/** The content of `e` (null: missing from the store / repository, or not these bytes). */
async function content(
  dir: string,
  cwd: string,
  e: Entry,
): Promise<Buffer | null> {
  try {
    const b =
      e.src === "store"
        ? await readFile(blobPath(dir, e.id))
        : (await git(cwd, ["cat-file", "blob", e.id], 30000)).out;
    return blobId(b) === e.id ? b : null;
  } catch {
    return null;
  }
}
/**
 * what rewinding the files to before `turnId` would do (nothing
 * changes yet; every byte to write is read and verified here). `rewound`:
 * the native turn ids from `turnId` on (all must have a checkpoint).
 * Conflicts / missing → the caller refuses the whole rewind.
 */
export async function planRewindFiles(
  sid: string,
  cwd: string,
  turnId: string,
  rewound: string[] = [turnId],
): Promise<RewindFilesPlan> {
  const plan: RewindFilesPlan = {
    missing: [],
    unrestorable: [],
    restore: [],
    conflicts: [],
    notRestored: [],
    others: [],
    othersCount: 0,
    cwd,
    sid,
    dir: "",
  };
  if (!active()) return { ...plan, reason: "unsupported" };
  let real: string;
  try {
    real = realpathOf(cwd);
  } catch {
    throw Error(turnT()("server-turns.checkpoint.noCwd", { cwd }));
  }
  const dir = sessionDir(sid),
    index = await loadIndex(dir);
  Object.assign(plan, { cwd: real, dir });
  const at = index?.cwd === real ? lastAt(index.turns, turnId) : -1;
  const turns = index && at >= 0 ? index.turns.slice(at) : [];
  for (const id of new Set([turnId, ...rewound])) {
    const t = turns.find((x) => x.turnId === id);
    if (!t) plan.missing.push({ turnId: id, why: "no-record" });
    else if (!t.pre || !t.post)
      plan.missing.push({ turnId: id, why: t.error || "no-snapshot" });
  }
  if (plan.missing.length) return { ...plan, reason: "no-checkpoint" };
  const mans = await Promise.all(
    turns.map(async (t) => ({
      pre: await loadManifest(dir, t.pre),
      post: await loadManifest(dir, t.post),
    })),
  );
  if (mans.some((x) => !x.pre || !x.post))
    return {
      ...plan,
      reason: "no-checkpoint",
      missing: [{ turnId, why: "snapshot-lost" }],
    };
  const pre = mans[0].pre!;
  /** Its first change from `turnId` on (an add: it did not exist). */
  const first = new Map<string, Change>();
  for (const t of turns) {
    for (const c of t.changed) if (!first.has(c.path)) first.set(c.path, c);
    for (const o of t.outside)
      if (!plan.notRestored.some((x) => x.path === o))
        plan.notRestored.push({ path: o, why: "outside" });
  }
  for (const [rel, change] of first) {
    // Review (followups-1109 B / C): reached through a symlinked folder or
    // a case alias — no snapshot can speak for it (said, refused).
    if (
      (await lstat(join(real, rel)).then(
        () => true,
        () => false,
      )) &&
      !(await canonical(real, rel))
    ) {
      plan.notRestored.push({ path: rel, why: "not-canonical" });
      continue;
    }
    let target = stateIn(pre, rel);
    // Review H2: deleted only when it provably did not exist — absent
    // from a complete listing *and* created by the edit tool.
    if (!("unknown" in target) && target.id === null && change.kind !== "add")
      target = { unknown: "no-snapshot" };
    if ("unknown" in target) {
      plan.notRestored.push({ path: rel, why: target.unknown });
      continue;
    }
    // Changed by someone else between the turns, or since the last one?
    let why = "";
    for (let k = 1; k < mans.length && !why; k++) {
      const a = stateIn(mans[k - 1].post, rel),
        b = stateIn(mans[k].pre, rel);
      if ("unknown" in a || "unknown" in b) why = "unverifiable";
      else if (a.id !== b.id) why = "changed-between-turns";
    }
    const last = stateIn(mans.at(-1)!.post, rel),
      now = await currentState(join(real, rel));
    if (!why) {
      if ("unknown" in last || "unknown" in now) why = "unverifiable";
      else if (last.id !== now.id) why = "changed-after";
    }
    if (why === "unverifiable") {
      plan.notRestored.push({ path: rel, why });
      continue;
    }
    if (why) {
      plan.conflicts.push({ path: rel, why });
      continue;
    }
    const nowId = (now as { id: string | null }).id;
    if (target.id === nowId) continue; // already as it was
    // Review (followups-1109): a delete only through the canonical name,
    // and only where git can say whether it is ignored.
    if (
      target.id === null &&
      !(
        (await canonical(real, rel)) &&
        (!(pre.git || mans.some((x) => x.pre!.git || x.post!.git)) ||
          (await gitDecides(real, rel)))
      )
    ) {
      plan.notRestored.push({ path: rel, why: "not-canonical" });
      continue;
    }
    let data: Buffer | null = null;
    if (target.entry) {
      // Review M3: read and verified now, before the history is rewound.
      data = await content(dir, real, target.entry);
      if (!data) {
        plan.notRestored.push({ path: rel, why: "missing" });
        continue;
      }
    }
    plan.restore.push({
      path: rel,
      data,
      mode: target.entry?.mode ?? 0o644,
      expect: nowId,
    });
  }
  // Review (followups-1109): a move's destination is deleted only when
  // its source comes back too — a source outside the workspace, in a
  // nested repo or otherwise not restored would lose the only copy.
  const back = (rel: string) =>
    !plan.notRestored.some((x) => x.path === rel) &&
    !plan.conflicts.some((x) => x.path === rel);
  for (const [rel, change] of first) {
    if (change.movedFrom === undefined) continue;
    if (change.movedFrom !== null && back(change.movedFrom)) continue;
    plan.restore = plan.restore.filter((x) => x.path !== rel);
    if (!plan.notRestored.some((x) => x.path === rel))
      plan.notRestored.push({ path: rel, why: "move-source" });
  }
  // What else differs from then (commands, people): said, not restored.
  try {
    const nowM = await snapshot(real, dir, mans.at(-1)!.post, {
      store: false,
    });
    const keys = new Set([
      ...Object.keys(pre.files),
      ...Object.keys(nowM.files),
    ]);
    const others: string[] = [];
    for (const k of keys)
      if (!first.has(k) && pre.files[k]?.id !== nowM.files[k]?.id)
        others.push(k);
    others.sort();
    plan.othersCount = others.length;
    plan.others = others.slice(0, 20);
  } catch {}
  plan.unrestorable = plan.notRestored.filter((x) => !BY_DESIGN.has(x.why));
  if (!first.size) plan.reason = "nothing";
  return plan;
}
/** Never restored, by design (said, not refused). */
const BY_DESIGN = new Set(["outside", "nested-repo"]);
/** Inside the workspace, not through a symlink, a regular file or absent. */
function writable(cwd: string, rel: string): string | null {
  if (forbidden(rel)) return null;
  const abs = join(cwd, rel);
  const r = relative(cwd, abs);
  if (!r || r.startsWith("..") || isAbsolute(r)) return null;
  let anc = dirname(abs);
  while (!existsSync(anc) && anc.length > cwd.length) anc = dirname(anc);
  try {
    const x = relative(cwd, realpathOf(anc));
    if (x.startsWith("..") || isAbsolute(x)) return null;
  } catch {
    return null;
  }
  return abs;
}
/** The Daisy temp name of a restore (recognizable, same folder). */
const restoreTemp = (abs: string) =>
  join(
    dirname(abs),
    `.${basename(abs)}.daisy-restore-${randomBytes(4).toString("hex")}`,
  );
export interface DaisyRewindFiles {
  reverted: boolean;
  /** ADR-152: `"harbor"` before (still read, commands.ts `rewindNotice`). */
  via: "fallback";
  reason?: string;
  filesChanged?: string[];
  notRestored?: { path: string; why: string }[];
  others?: string[];
  othersCount?: number;
}
/**
 * Applies a conflict-free plan (after the conversation was rewound).
 * `complete`: every planned file was restored (then the rewound turns'
 * checkpoints can go).
 */
export async function applyRewindFiles(
  plan: RewindFilesPlan,
): Promise<DaisyRewindFiles & { complete: boolean }> {
  const notRestored = [...plan.notRestored],
    done: string[] = [];
  // Re-review M-2: an AI-edited file not restored keeps the checkpoints.
  let complete = plan.unrestorable.length === 0;
  /**
   * Re-review: right before the rename / unlink, the folder is still
   * inside the workspace (no symlink swapped in) and the target still a
   * regular file or absent.
   */
  const stillSafe = async (abs: string) => {
    try {
      const x = relative(plan.cwd, realpathOf(dirname(abs)));
      if (x.startsWith("..") || isAbsolute(x)) return false;
      const st = await lstat(abs).catch((e: any) =>
        e?.code === "ENOENT" ? null : Promise.reject(e),
      );
      return !st || st.isFile();
    } catch {
      return false;
    }
  };
  for (const r of plan.restore) {
    const abs = writable(plan.cwd, r.path);
    if (!abs) {
      notRestored.push({ path: r.path, why: "unsafe" });
      complete = false;
      continue;
    }
    // Review M1: still what the plan saw — else someone just changed it.
    const now = await currentState(abs);
    if ("unknown" in now || now.id !== r.expect) {
      notRestored.push({ path: r.path, why: "changed-during-rewind" });
      complete = false;
      continue;
    }
    let tmp = "";
    try {
      if (r.data) {
        await mkdir(dirname(abs), { recursive: true });
        tmp = restoreTemp(abs);
        await writeFile(tmp, r.data, { mode: r.mode, flag: "wx" });
        await chmod(tmp, r.mode);
        if (!(await stillSafe(abs)))
          throw Object.assign(Error(), { code: "unsafe" });
        await rename(tmp, abs);
        tmp = "";
      } else {
        // Defense in depth: a plan with anything unrestorable deletes nothing.
        if (plan.unrestorable.length)
          throw Object.assign(Error(), { code: "kept-unrestorable" });
        if (!(await stillSafe(abs)) || !(await canonical(plan.cwd, r.path)))
          throw Object.assign(Error(), { code: "unsafe" });
        const st = await lstat(abs).catch(() => null);
        if (st?.isFile()) await unlink(abs);
      }
      done.push(abs);
    } catch (e: any) {
      complete = false;
      notRestored.push({
        path: r.path,
        why: String(e?.code || e?.message || "error").slice(0, 60),
      });
    } finally {
      if (tmp) await rm(tmp, { force: true });
    }
  }
  return {
    reverted: done.length > 0,
    via: "fallback",
    ...(done.length ? {} : { reason: plan.reason || "nothing" }),
    filesChanged: done,
    ...(notRestored.length ? { notRestored } : {}),
    ...(plan.othersCount
      ? { others: plan.others, othersCount: plan.othersCount }
      : {}),
    complete,
  };
}
/**
 * The conversation no longer has `turnId` and after: their checkpoints go
 * (review L3: also the later ones when `turnId` itself has none —
 * `rewound` names them).
 */
export async function dropCheckpointsFrom(
  sid: string,
  turnId: string,
  rewound: string[] = [],
) {
  if (!root) return;
  const dir = sessionDir(sid);
  await serial(dir, async () => {
    const index = await loadIndex(dir);
    if (!index) return;
    const gone = new Set([turnId, ...rewound]);
    let at = lastAt(index.turns, turnId);
    if (at < 0) at = index.turns.findIndex((t) => gone.has(t.turnId));
    if (at < 0) return;
    index.turns = index.turns.slice(0, at);
    await prune(dir, index);
  }).catch(() => {});
}
/** Re-review M-2: the refusal when an AI-edited file cannot be restored. */
export function unrestorableMessage(plan: RewindFilesPlan) {
  const t = turnT();
  const why = (w: string) => (t.has(`server-turns.checkpoint.why.${w}`) ? t.dynamic(`server-turns.checkpoint.why.${w}`) : w);
  const list = plan.unrestorable;
  const files = list
    .slice(0, 6)
    .map((x) => t("server-turns.checkpoint.fileWhy", { path: x.path, why: why(x.why) }))
    .join(t("server-turns.list.comma"));
  return t("server-turns.checkpoint.unrestorable", {
    n: list.length,
    files: list.length > 6 ? t("server-turns.list.andMore", { list: files }) : files,
  });
}
/** the refusal when files changed after the AI's edit. */
export function conflictMessage(plan: RewindFilesPlan) {
  const names = plan.conflicts.map((c) => c.path);
  const t = turnT();
  const files = names.slice(0, 8).join(t("server-turns.list.comma"));
  return t("server-turns.checkpoint.conflict", {
    n: names.length,
    files: names.length > 8 ? t("server-turns.list.andMore", { list: files }) : files,
  });
}
/** Review L4: the refusal when a rewound turn has no checkpoint. */
export function missingMessage(plan: RewindFilesPlan) {
  const why = plan.missing.find(
    (m) => !["no-record", "no-snapshot", "snapshot-lost"].includes(m.why),
  )?.why;
  return turnT()("server-turns.checkpoint.missing", {
    n: plan.missing.length,
    why: why ?? turnT()("server-turns.checkpoint.missingWhy"),
  });
}
