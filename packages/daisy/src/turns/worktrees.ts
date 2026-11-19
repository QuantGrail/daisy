import { turnT } from "../harness/model-switch.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, existsSync, realpathSync, lstatSync } from "node:fs";
import { join } from "node:path";
const exec = promisify(execFile);
const git = async (cwd: string, args: string[], signal?: AbortSignal) =>
  (
    await exec("git", ["-C", cwd, ...args], {
      signal,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    })
  ).stdout.trim();
/** Where isolated worktrees go, under the repository's git directory. */
export const WORKTREE_ROOT = "daisy-worktrees";
export const BRANCH_PREFIX = "daisy/";
/** The names before P6-03: still used for a worktree made under them. */
export const LEGACY_WORKTREE_ROOT = "harbor-worktrees";
export const LEGACY_BRANCH_PREFIX = "harbor/";
export async function isolatedWorkspace(
  source: string,
  sid: string,
  signal: AbortSignal,
  validate: (path: string) => void = () => {},
  committedOnly = false,
  /** false = only an existing worktree (a sidecar reads its main session's). */
  create = true,
) {
  signal.throwIfAborted();
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(sid)) throw Error(turnT()("server-turns.worktree.badSid"));
  const common = realpathSync(
    await git(
      source,
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      signal,
    ),
  );
  validate(common);
  // P6-03 (ADR-153): new worktrees are <git>/daisy-worktrees/<sid> on
  // branch daisy/<sid>; one made under the old names (harbor-worktrees,
  // harbor/<sid>) is still found and used as it is.
  for (const name of [WORKTREE_ROOT, LEGACY_WORKTREE_ROOT]) {
    const p = join(common, name);
    if (existsSync(p) && lstatSync(p).isSymbolicLink())
      throw Error(turnT()("server-turns.worktree.rootSymlink"));
  }
  const legacy = join(common, LEGACY_WORKTREE_ROOT, sid);
  const old =
    !existsSync(join(common, WORKTREE_ROOT, sid)) && existsSync(legacy);
  const dir = old ? legacy : join(common, WORKTREE_ROOT, sid),
    branch = (old ? LEGACY_BRANCH_PREFIX : BRANCH_PREFIX) + sid;
  if (existsSync(dir) && lstatSync(dir).isSymbolicLink())
    throw Error(turnT()("server-turns.worktree.symlink"));
  if (!existsSync(dir) && !create)
    throw Error(
      turnT()("server-turns.worktree.noMainWorkspace"),
    );
  if (!existsSync(dir)) {
    // Refuse to silently omit uncommitted source work.
    if (
      !committedOnly &&
      (await git(source, ["status", "--porcelain"], signal))
    )
      throw Error(turnT()("server-turns.worktree.dirty"));
    mkdirSync(join(common, WORKTREE_ROOT), {
      recursive: true,
      mode: 0o700,
    });
    await git(source, ["worktree", "add", "-b", branch, dir, "HEAD"], signal);
  }
  if ((await git(dir, ["branch", "--show-current"], signal)) !== branch)
    throw Error(turnT()("server-turns.worktree.branchChanged"));
  return { path: realpathSync(dir), branch };
}
