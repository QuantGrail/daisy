import { createHash } from "node:crypto";
import { ownerT } from "../platform/language.ts";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type { RunnerJob } from "../../../contracts/src/index.ts";
import type { Runtime } from "../harness/shared.ts";
import { jobToolNames, layeredGuide, type ToolSpec } from "../tools/daisy-tools.ts";
/**
 * One activity item per process launch — what Daisy
 * appended to the system layer, which org core it holds, what else the
 * engine will load by itself (instruction files, the memory index), how the
 * process was started. Read-only evidence for the 「提示词」 page; never
 * holds a credential (arguments carry none: keys are environment).
 */
let build: string | null = null;
/** The release this Runner process loaded (worker start). */
export function setRunnerBuild(release: string | null | undefined) {
  build = release || null;
}
export const runnerBuild = () => build;
const sha = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
const FILE_MAX = 1024 * 1024;
function fileInfo(path: string) {
  try {
    const st = statSync(path);
    if (!st.isFile()) return null;
    return {
      path,
      bytes: st.size,
      ...(st.size <= FILE_MAX ? { sha256: sha(readFileSync(path)) } : {}),
    };
  } catch {
    return null;
  }
}
/** The engine's own instruction files from `cwd` up to the home directory. */
export function instructionFiles(agent: string, cwd: string, home = homedir()) {
  const names = agent === "claude" ? ["CLAUDE.md"] : ["AGENTS.md"];
  const dirs: string[] = [];
  let d = resolve(cwd);
  const under = d === home || d.startsWith(home + sep);
  for (let i = 0; i < 40; i++) {
    dirs.push(d);
    if (!under || d === home) break;
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  if (!dirs.includes(home)) dirs.push(home);
  const out: { path: string; bytes: number; sha256?: string }[] = [];
  for (const dir of dirs)
    for (const n of names) {
      const f = fileInfo(join(dir, n));
      if (f) out.push(f);
    }
  return out;
}
/** Claude Code's auto-memory index of this project, when there is one. */
function memoryIndex(job: RunnerJob, cwd: string) {
  if (job.session.agent !== "claude") return null;
  const root = job.profile.configDir || join(homedir(), ".claude");
  const path = join(
    root,
    "projects",
    resolve(cwd).replace(/[^A-Za-z0-9]/g, "-"),
    "memory",
    "MEMORY.md",
  );
  if (!existsSync(path)) return null;
  const f = fileInfo(path);
  return f ? { path: f.path, bytes: f.bytes } : null;
}
export interface LaunchAudit {
  /** The appended system-layer text ("" = none). */
  guide: string;
  /** How the native conversation was opened. */
  mode: "start" | "resume" | "fork";
  /**
   * Does the model get this text now? "launch": yes, with this start ·
   * "injected": a developer message after resume / fork · "recorded": the
   * engine keeps the text it recorded earlier until a compaction ·
   * "unknown".
   */
  delivery: "launch" | "injected" | "recorded" | "unknown";
  args: string[];
  engine: { name: string; version?: string };
  cwd: string;
  tools: ToolSpec[];
  note?: string;
}
export function launchAudit(rt: Runtime, a: LaunchAudit) {
  const g = layeredGuide(rt.job);
  // Part of the layered prompt: a job without it (the switch off, or not
  // on for this session) writes no such item — as before the layered prompt.
  if (!g) return;
  try {
    rt.emit("item", {
      id: `${rt.job.id}:launch-audit`,
      kind: "tool",
      category: "audit",
      name: ownerT()("server.launchAudit.name"),
      status: "complete",
      text: a.guide,
      createdAt: Date.now(),
      input: {
        guideSha256: sha(a.guide),
        layered: !!g,
        ...(g
          ? { stable: g.stable, org: g.org, layers: g.layers, fresh: g.fresh }
          : {}),
        mode: a.mode,
        delivery: a.delivery,
        ...(a.note ? { note: a.note } : {}),
        // ADR-154: was `harborTools`; `toolNames`: the names they went by.
        toolNames: jobToolNames(rt.job) ?? "daisy",
        daisyTools: a.tools.map((t) => ({
          name: t.name,
          sha256: sha(t.description),
        })),
        engine: a.engine,
        runnerBuild: build,
        args: a.args,
        cwd: a.cwd,
        instructionFiles: instructionFiles(rt.job.session.agent, a.cwd),
        memoryIndex: memoryIndex(rt.job, a.cwd),
      },
    });
  } catch {
    // Evidence only: never in the way of a launch.
  }
}
