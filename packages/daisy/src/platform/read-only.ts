import { acpHarness } from "../../../contracts/src/acp-harnesses.ts";
import { ownerT } from "./language.ts";
import { existsSync, realpathSync, mkdirSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import type { RunnerJob } from "../../../contracts/src/index.ts";

/**
 * Kernel-enforced read-only filesystem, independent of model/tool approval.
 * `providerState: false` (Daisy's background commands, review 2026-11-03):
 * the Agent's own login / config directory stays read-only too — only the
 * Agent process itself needs to write it.
 */
export function readOnlyLaunch(
  job: RunnerJob,
  cwd: string,
  o: {
    providerState?: boolean;
    network?: boolean;
    /**
     * directories that stay writable instead of the whole provider
     * state (a sidecar: only Claude's transcript directory).
     */
    writable?: string[];
  } = {},
) {
  if (!["read-only", "snapshot"].includes(job.session.workspaceMode || ""))
    return undefined;
  if (process.platform !== "linux" || !existsSync("/usr/bin/bwrap"))
    throw Error(
      ownerT()("server-platform.readOnly.needsBwrap"),
    );
  const home = homedir();
  const state = job.profile.configDir
    ? [job.profile.configDir]
    : job.session.agent === "claude"
      ? [resolve(home, ".claude"), resolve(home, ".claude.json")]
      : job.session.agent === "codex"
        ? [resolve(home, ".codex")]
        : // P4-10: an ACP harness's own directory, when its entry names one.
          (acpHarness(job.session.agent)?.configDir
            ? [resolve(home, acpHarness(job.session.agent)!.configDir!.home)]
            : []);
  const inside = (parent: string, child: string) => {
    const r = relative(parent, child);
    return r === "" || (r !== ".." && !r.startsWith("../") && !isAbsolute(r));
  };
  const scratch = `/tmp/daisy-private-${process.getuid!()}`;
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const st = lstatSync(scratch);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid!())
    throw Error(ownerT()("server-platform.readOnly.scratchUnsafe"));
  const root = realpathSync(cwd);
  if (inside(scratch, root) || inside(root, scratch))
    throw Error(ownerT()("server-platform.readOnly.overlapsScratch"));
  // Provider state is writable, but must not overlap the project. Broad home
  // workspaces must select a project directory for enforced read-only access.
  const writable = o.writable
    ? o.writable.filter(existsSync).map((p) => realpathSync(p))
    : o.providerState === false
      ? []
      : state.filter(existsSync).map((p) => realpathSync(p));
  for (const p of writable)
    if (inside(root, p) || inside(p, root))
      throw Error(
        ownerT()("server-platform.readOnly.overlapsState"),
      );
  return [
    "--die-with-parent",
    "--new-session",
    "--unshare-pid",
    ...(o.network === false ? ["--unshare-net"] : []),
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    // Private temp/cache: test/build tools cannot write into the source tree.
    "--tmpfs",
    scratch,
    "--dir",
    `${scratch}/cache`,
    "--setenv",
    "TMPDIR",
    scratch,
    "--setenv",
    "XDG_CACHE_HOME",
    `${scratch}/cache`,
    ...writable.flatMap((p) => ["--bind", p, p]),
    "--chdir",
    root,
    "--",
  ];
}
