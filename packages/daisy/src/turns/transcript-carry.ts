import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Lang } from "../../../contracts/src/i18n.ts";
import { LEGACY_PROMPT_LANG, promptT, type PromptT } from "../../../contracts/src/prompt-i18n.ts";
import "../prompts/lang.ts";
/**
 * 「换身份」, Runner side: Claude Code keeps a conversation's
 * transcript under its config directory
 * (`<dir>/projects/<cwd as a name>/<sessionId>.jsonl`, plus a
 * `<sessionId>/` directory of the same conversation's subagent / tool-result
 * files), so `--resume` under another identity's directory says 「No
 * conversation found」 (measured, Claude Code 2.1.316). Once after a switch
 * (the control plane then forgets the switch), before any Claude command of
 * the conversation, the Runner copies that one conversation's files from
 * the old identity's directory into the new one:
 *
 * - nothing else. Each source file is opened with O_NOFOLLOW (a link as the
 *   last component is refused) and its descriptor must be a regular file
 *   with one link; it is read from that descriptor. Source directories are
 *   checked with lstat as they are walked (real directories of this user);
 *   on the target side every directory below the config directory is
 *   checked the same way (created 0700 when missing) and then used — a
 *   check-then-use, so a same-user race in between is not excluded;
 * - streamed in chunks (never the whole file in memory); at most `limit`
 *   bytes (512 MiB) of what actually needs copying — files already the
 *   same are not counted — and the bytes read while copying count too
 *   (a file that grew stops the copy, its temporary file removed);
 * - a file already there is replaced only when it is a byte prefix of the
 *   source (the same conversation, fewer turns), left alone when the source
 *   is a prefix of it (already carried, then more turns); otherwise it is
 *   kept, renamed `<name>.before-switch-<time>`, and reported. Every such
 *   file of this conversation is reported on each carry, so one renamed
 *   just before a crash is still told about the next time;
 * - written to a temporary name `<name>.<uuid>.carry` (0600) and renamed;
 *   leftovers of an interrupted carry are removed first.
 */
export const CARRY_LIMIT = 512 * 1024 * 1024;
/** A part of a message that is itself a message (`{what}`: which directory). */
type Part = { key: string; params?: Record<string, unknown> };
/**
 * Carrying refused (the turn must not start as if it had worked). P6-24:
 * the reason is a message key (`prompt-carry.*`); `message` is it in the
 * language `carryClaudeTranscript` was given (the session's), Chinese
 * until then.
 */
export class CarryError extends Error {
  constructor(
    public key: string,
    public params: Record<string, unknown> = {},
  ) {
    super("");
    this.message = this.render(promptT(LEGACY_PROMPT_LANG));
  }
  render(t: PromptT): string {
    const p = Object.fromEntries(
      Object.entries(this.params).map(([k, v]) => [
        k,
        v && typeof v === "object" && "key" in (v as Part) ? t.dynamic((v as Part).key, (v as Part).params) : v,
      ]),
    );
    return t.dynamic(this.key, p);
  }
}
/** A file name, never a path (Claude Code's ids are UUIDs). */
const SAFE_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
const TEMP =
  /\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.carry$/;
/** The config directory Claude Code uses for this identity ("" = the Runner user's). */
export function claudeConfigDir(configDir: string, env = process.env) {
  return configDir || env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}
export interface CarryResult {
  /** Files written into the new directory. */
  copied: number;
  /** This conversation's files kept aside (renamed), now or earlier (paths). */
  kept: string[];
  /** Why nothing was copied (already there…). */
  skipped?: string;
}
const uid = () => process.getuid?.() ?? -1;
const missing = (e: any) => e?.code === "ENOENT";
/** A real directory of this user (not a link), or a CarryError. */
async function realDir(path: string, what: Part) {
  const st = await lstat(path);
  if (!st.isDirectory() || st.isSymbolicLink())
    throw new CarryError("prompt-carry.notPlainDir", { what });
  if (uid() >= 0 && st.uid !== uid())
    throw new CarryError("prompt-carry.notOwned", { what });
}
/** `parent/name` as a real directory of this user, created 0700 if missing. */
async function childDir(parent: string, name: string) {
  const path = join(parent, name);
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (e: any) {
    if (e?.code !== "EEXIST") throw e;
  }
  await realDir(path, { key: "prompt-carry.what.dir", params: { name } });
  return path;
}
/** A config directory itself: may be a link the owner configured; resolved. */
async function rootDir(path: string, create: boolean) {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const real = await realpath(path);
  await realDir(real, { key: "prompt-carry.what.configDir" });
  return real;
}
/** Open a source file: no link followed, a regular file with one link. */
async function source(path: string) {
  let fh: FileHandle;
  try {
    fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e: any) {
    if (e?.code === "ELOOP") throw new CarryError("prompt-carry.transcriptLink");
    throw e;
  }
  const st = await fh.stat();
  if (!st.isFile() || st.nlink !== 1) {
    await fh.close();
    throw new CarryError("prompt-carry.transcriptNotFile");
  }
  return { fh, size: st.size };
}
const CHUNK = 1024 * 1024;
/** `a`'s first `n` bytes equal `b`'s. */
async function samePrefix(a: FileHandle, b: FileHandle, n: number) {
  const x = Buffer.alloc(CHUNK),
    y = Buffer.alloc(CHUNK);
  for (let at = 0; at < n;) {
    const want = Math.min(CHUNK, n - at);
    const [r1, r2] = await Promise.all([
      a.read(x, 0, want, at),
      b.read(y, 0, want, at),
    ]);
    if (r1.bytesRead !== want || r2.bytesRead !== want) return false;
    if (!x.subarray(0, want).equals(y.subarray(0, want))) return false;
    at += want;
  }
  return true;
}
/** What the byte budget of one carry has left. */
interface Budget {
  left: number;
  limit: number;
}
const overLimit = (limit: number, bytes: number) =>
  new CarryError("prompt-carry.tooBig", {
    size: Math.ceil(bytes / 1024 / 1024),
    limit: Math.round(limit / 1024 / 1024),
  });
/** Streamed in 1 MiB chunks until EOF, every byte charged to `budget`. */
async function copyHandle(from: FileHandle, to: FileHandle, budget: Budget) {
  const buf = Buffer.alloc(CHUNK);
  for (let at = 0; ;) {
    const { bytesRead } = await from.read(buf, 0, CHUNK, at);
    if (!bytesRead) return;
    budget.left -= bytesRead;
    if (budget.left < 0)
      throw overLimit(budget.limit, budget.limit - budget.left);
    for (let off = 0; off < bytesRead;) {
      const { bytesWritten } = await to.write(
        buf,
        off,
        bytesRead - off,
        at + off,
      );
      off += bytesWritten;
    }
    at += bytesRead;
  }
}
interface Plan {
  src: string;
  /** Destination directory (already checked) and name. */
  dir: string;
  name: string;
  /** Decided before anything is written. */
  action?: "same" | "replace" | "aside";
  size?: number;
}
/** Is the target the same / a prefix / something else? (nothing written) */
async function decide(p: Plan) {
  const src = await source(p.src);
  try {
    p.size = src.size;
    let there: Awaited<ReturnType<typeof lstat>> | null = null;
    try {
      there = await lstat(join(p.dir, p.name));
    } catch (e) {
      if (!missing(e)) throw e;
    }
    if (!there) return (p.action = "replace");
    if (!there.isFile() || there.isSymbolicLink()) return (p.action = "aside");
    const d = await open(
      join(p.dir, p.name),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      // The target is the source plus later turns (a carry whose report
      // was lost, then turns): already carried.
      const prefix = await samePrefix(
        src.fh,
        d,
        Math.min(there.size, src.size),
      );
      p.action = !prefix
        ? "aside"
        : there.size >= src.size
          ? "same"
          : "replace";
    } finally {
      await d.close();
    }
  } finally {
    await src.fh.close();
  }
}
/** Leftovers of an interrupted carry of `name` in `dir` (ours: `.carry`). */
async function clearTemps(dir: string, name: string) {
  for (const f of await readdir(dir).catch(() => [] as string[]))
    if (f.startsWith(`${name}.`) && TEMP.test(f)) {
      const st = await lstat(join(dir, f)).catch(() => null);
      if (st?.isFile() && (uid() < 0 || st.uid === uid()))
        await unlink(join(dir, f)).catch(() => {});
    }
}
/** This conversation's files kept aside in `dir`, earlier or now. */
async function asides(dir: string, name: string) {
  return (await readdir(dir).catch(() => [] as string[]))
    .filter((f) => f.startsWith(`${name}.before-switch-`))
    .map((f) => join(dir, f));
}
async function carryFile(p: Plan, stamp: string, budget: Budget) {
  const dst = join(p.dir, p.name);
  if (p.action === "aside") await rename(dst, `${dst}.before-switch-${stamp}`);
  const src = await source(p.src);
  const tmp = `${dst}.${randomUUID()}.carry`;
  try {
    const out = await open(
      tmp,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await copyHandle(src.fh, out, budget);
      await out.sync();
    } finally {
      await out.close();
    }
    await rename(tmp, dst);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  } finally {
    await src.fh.close();
  }
}
/** Regular files under `from` (links skipped), destinations made as it goes. */
async function planTree(
  from: string,
  to: string,
  out: Plan[],
  depth = 0,
): Promise<void> {
  if (depth > 8) throw new CarryError("prompt-carry.tooDeep");
  await realDir(from, { key: "prompt-carry.what.extraDir" });
  for (const d of await readdir(from, { withFileTypes: true })) {
    const a = join(from, d.name);
    if (d.isDirectory())
      await planTree(a, await childDir(to, d.name), out, depth + 1);
    else if (d.isFile()) {
      const st = await lstat(a);
      if (st.nlink !== 1)
        throw new CarryError("prompt-carry.extraLinks");
      out.push({ src: a, dir: to, name: d.name });
    }
  }
}
export async function carryClaudeTranscript(opts: {
  fromDir: string;
  toDir: string;
  sessionId: string;
  limit?: number;
  now?: number;
  /** The language of the reasons (the session's; absent: Chinese, as before P6-24). */
  lang?: Lang;
}): Promise<CarryResult> {
  const t = promptT(opts.lang ?? LEGACY_PROMPT_LANG);
  try {
    const r = await carry(opts);
    return r.skipped ? { ...r, skipped: t.dynamic(r.skipped) } : r;
  } catch (e) {
    if (e instanceof CarryError) e.message = e.render(t);
    throw e;
  }
}
/** `carryClaudeTranscript`, `skipped` as a message key. */
async function carry(opts: {
  fromDir: string;
  toDir: string;
  sessionId: string;
  limit?: number;
  now?: number;
}): Promise<CarryResult> {
  const { sessionId } = opts,
    limit = opts.limit ?? CARRY_LIMIT;
  if (!SAFE_ID.test(sessionId) || sessionId.includes(".."))
    throw new CarryError("prompt-carry.badId");
  let fromDir: string;
  try {
    fromDir = await rootDir(opts.fromDir, false);
  } catch (e: any) {
    if (missing(e)) throw new CarryError("prompt-carry.noOldDir");
    throw e;
  }
  const toDir = await rootDir(opts.toDir, true);
  if (fromDir === toDir)
    return { copied: 0, kept: [], skipped: "prompt-carry.sameDir" };
  const file = `${sessionId}.jsonl`;
  // The project folder that holds this conversation (newest if several).
  const projects = join(fromDir, "projects");
  const found: { dir: string; mtime: number }[] = [];
  try {
    await realDir(projects, { key: "prompt-carry.what.projects" });
    for (const d of await readdir(projects, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      try {
        const st = await lstat(join(projects, d.name, file));
        if (st.isFile()) found.push({ dir: d.name, mtime: st.mtimeMs });
        else if (st.isSymbolicLink())
          throw new CarryError("prompt-carry.transcriptLink");
      } catch (e) {
        if (!missing(e)) throw e;
      }
    }
  } catch (e) {
    if (!missing(e)) throw e;
  }
  const proj = found.sort((a, b) => b.mtime - a.mtime)[0]?.dir;
  if (!proj) {
    // Not under the old identity: fine only if the new one already has it.
    for (const d of await readdir(join(toDir, "projects"), {
      withFileTypes: true,
    }).catch(() => []))
      if (
        d.isDirectory() &&
        (await lstat(join(toDir, "projects", d.name, file)).catch(() => null))
      )
        return { copied: 0, kept: [], skipped: "prompt-carry.alreadyThere" };
    throw new CarryError("prompt-carry.notFound");
  }
  const src = join(projects, proj);
  await realDir(src, { key: "prompt-carry.what.dir", params: { name: proj } });
  const dst = await childDir(await childDir(toDir, "projects"), proj);
  const plan: Plan[] = [{ src: join(src, file), dir: dst, name: file }];
  try {
    const extra = await lstat(join(src, sessionId));
    if (extra.isDirectory() && !extra.isSymbolicLink())
      await planTree(
        join(src, sessionId),
        await childDir(dst, sessionId),
        plan,
      );
  } catch (e) {
    if (!missing(e)) throw e;
  }
  for (const p of plan) {
    await clearTemps(p.dir, p.name);
    await decide(p);
  }
  // Only what has to be copied counts against the limit.
  const bytes = plan
    .filter((p) => p.action !== "same")
    .reduce((n, p) => n + (p.size ?? 0), 0);
  if (bytes > limit) throw overLimit(limit, bytes);
  const stamp = new Date(opts.now ?? Date.now())
    .toISOString()
    .replace(/[:.]/g, "-");
  const budget = { left: limit, limit };
  let copied = 0;
  for (const p of plan)
    if (p.action !== "same") {
      await carryFile(p, stamp, budget);
      copied++;
    }
  const kept = [
    ...new Set(
      (await Promise.all(plan.map((p) => asides(p.dir, p.name)))).flat(),
    ),
  ].sort();
  return copied
    ? { copied, kept }
    : { copied: 0, kept, skipped: "prompt-carry.sameRecords" };
}
