import { turnT } from "../harness/model-switch.ts";
import { daisyEnv } from "../../../contracts/src/env.ts";
import { execFile } from "node:child_process";
import { resolveSpawn } from "../platform/spawn.ts";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerJob } from "../../../contracts/src/index.ts";
import {
  NATIVE_TITLE_MS,
  SESSION_TITLE_BUDGET_MS,
  sanitizeTitle,
} from "../../../contracts/src/title.ts";
import { sessionT } from "../../../contracts/src/prompt-i18n.ts";
import "../prompts/lang.ts";
import { agentEnv } from "../harness/shared.ts";
import { pluginEnvKeys } from "../plugins/runner.ts";
import { log } from "../observe/log.ts";

/**
 * Conversation title: after the second
 * completed round the control plane hands the Runner one prompt built from
 * the first two rounds; the Runner makes one short, tool-less, headless call
 * to the user's own CLI with its cheapest model, billed to the same identity
 * as the conversation. Never blocks or holds the session; any failure keeps
 * the placeholder (the control plane retries once after round 3).
 */
export interface TitleRequest {
  /** Built by the control plane (contracts `sessionTitlePrompt`). */
  prompt: string;
  /**
   * the rounds alone (contracts `sessionTitleDescription`), for an
   * agent that names the conversation natively; absent from an older
   * control plane.
   */
  description?: string;
  stage?: "final";
  attempt?: number;
}
type Run = (
  bin: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; cwd: string; timeoutMs: number },
) => Promise<string>;

const run: Run = (bin, args, { env, cwd, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      ...resolveSpawn(bin, args, env),
      { env, cwd, timeout: timeoutMs, maxBuffer: 256 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(String(stdout))),
    );
    child.stdin?.end();
  });
let runner: Run = run;
/** Tests replace the CLI call (no real model requests in tests). */
export function setTitleRunner(next?: Run) {
  runner = next || run;
}

/** Config overrides that leave a Codex title call without tools. */
export const CODEX_NO_TOOLS = [
  "features.shell_tool=false",
  "features.unified_exec=false",
  "features.view_image=false",
  "features.image_generation=false",
  "features.multi_agent=false",
  "features.goals=false",
  "features.apps=false",
  "features.plugins=false",
  "features.browser_use=false",
  "features.computer_use=false",
  "features.hooks=false",
  'web_search="disabled"',
  "mcp_servers={}",
  "project_doc_max_bytes=0",
];
/** The CLI call for this Agent, or null when it has no headless title mode. */
export function titleCommand(job: RunnerJob, prompt: string, outFile: string) {
  const model = job.profile.model || "";
  if (job.session.agent === "claude")
    return {
      bin: daisyEnv("DAISY_CLAUDE_BIN") || "claude",
      args: [
        "-p",
        prompt,
        // A compatible service (baseUrl) may not offer haiku: use its model.
        "--model",
        job.profile.baseUrl && model ? model : "haiku",
        "--system-prompt",
        // Claude's own system prompt is for coding work: a namer needs only this.
        sessionT(job.session)("prompt-title.namer"),
        "--tools",
        "",
        "--no-session-persistence",
        "--strict-mcp-config",
        "--output-format",
        "text",
      ],
    };
  if (job.session.agent === "codex")
    return {
      bin: daisyEnv("DAISY_CODEX_BIN") || "codex",
      args: [
        "exec",
        "--skip-git-repo-check",
        "--ephemeral",
        "--sandbox",
        "read-only",
        // No tools, as on the Claude path (review 2026-10-30): the prompt
        // carries other people's text. Not loading the user's config
        // drops their MCP servers / profiles (auth still comes from
        // CODEX_HOME); the feature switches remove shell, web, images, apps,
        // plugins and sub-agents. `-c features.*` tolerates names an older
        // CLI does not know; checked against codex-cli 0.157 (only the inert
        // request_user_input remains).
        "--ignore-user-config",
        "--ignore-rules",
        ...CODEX_NO_TOOLS.flatMap((c) => ["-c", c]),
        "--color",
        "never",
        "-o",
        outFile,
        ...(daisyEnv("DAISY_TITLE_CODEX_MODEL") || model
          ? ["-m", daisyEnv("DAISY_TITLE_CODEX_MODEL") || model]
          : []),
        "-c",
        'model_reasoning_effort="low"',
        prompt,
      ],
    };
  return null;
}

export async function generateTitle(
  job: RunnerJob,
  req: { prompt: string },
  timeoutMs = 45_000,
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "daisy-title-"));
  try {
    const outFile = join(dir, "title.txt");
    const cmd = titleCommand(job, req.prompt, outFile);
    if (!cmd) return "";
    const env = agentEnv(job);
    // Not the conversation's own work: nothing a plugin adds for the
    // session (P1-10; e.g. attribution) goes with it.
    for (const key of pluginEnvKeys()) delete env[key];
    // A neutral directory: no project instructions or files in the prompt.
    const out = await runner(cmd.bin, cmd.args, { env, cwd: dir, timeoutMs });
    let text = out;
    if (job.session.agent === "codex")
      try {
        text = readFileSync(outFile, "utf8");
      } catch {
        /* fall back to stdout */
      }
    return sanitizeTitle(text);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Why a call failed, for the service log. Not the error message: a failed
 * command's message repeats its arguments, i.e. the conversation.
 */
function failure(e: any) {
  if (e?.killed) return "timed out";
  if (typeof e?.code === "number") return `exit ${e.code}`;
  return String(e?.code || e?.message || e).slice(0, 120);
}
/** Tests shorten the attempt budget. */
const budget = () =>
  Number(daisyEnv("DAISY_TITLE_BUDGET_MS")) || SESSION_TITLE_BUDGET_MS;
/** Title calls still running: the Runner restarts only without any. */
let naming = 0;
/** Sessions whose title is being generated here (one call each at a time). */
const titling = new Set<string>();
export const namingInFlight = () => naming;
async function tracked<T>(work: () => Promise<T>) {
  naming++;
  try {
    return await work();
  } finally {
    naming--;
  }
}

/**
 * Generate and report. `report("")` = this attempt failed (the control plane
 * may then retry after the next round); logs and gives up on any failure.
 */
/**
 * the session's own live process names it (Claude Code
 * `generate_session_title`); null / "" = it could not, Daisy's CLI call
 * does it instead.
 */
export type NativeTitle = (
  description: string,
  timeoutMs: number,
) => Promise<string | null>;
export async function suggestTitle(
  job: RunnerJob,
  req: TitleRequest,
  report: (title: string) => Promise<unknown>,
  native?: NativeTitle | null,
  /**
   * Re-review L-d: report the owner's native name as the rename it is;
   * true = Daisy took it, nothing to name.
   */
  owner?: (() => Promise<boolean>) | null,
) {
  const sid = job.session.id;
  if (typeof req?.prompt !== "string" || !req.prompt || titling.has(sid))
    return;
  titling.add(sid);
  await tracked(async () => {
    let title = "";
    // Review M3: everything below within the budget the control plane waits.
    const deadline = Date.now() + budget();
    if (owner)
      try {
        if (await owner()) {
          titling.delete(sid);
          return;
        }
      } catch (e) {
        log.error(
          `Session ${sid}: native name not reported, naming it (${failure(e)})`,
        );
      }
    try {
      if (native && typeof req.description === "string" && req.description)
        try {
          title = sanitizeTitle(
            (await native(
              req.description,
              Math.max(1000, Math.min(NATIVE_TITLE_MS, deadline - Date.now())),
            )) || "",
          );
        } catch (e) {
          log.error(
            `Session ${sid}: native title not generated, asking the CLI (${failure(e)})`,
          );
        }
      const left = Math.min(45_000, deadline - Date.now());
      if (!title && left >= 5_000) title = await generateTitle(job, req, left);
      if (!title) throw Error("empty answer");
    } catch (e) {
      log.error(
        `Session ${sid}: title not generated, kept the placeholder (${failure(e)})`,
      );
    }
    try {
      await report(title);
    } catch (e) {
      log.error(
        `Session ${sid}: title not reported (${(e as Error).message.slice(0, 200)})`,
      );
    } finally {
      titling.delete(sid);
    }
  });
}
