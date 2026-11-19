/**
 * 「只问」 sidecars on the Runner: how a sidecar session starts
 * (forked from its main session's native context) and the read-only
 * settings each provider enforces. The control plane gives a sidecar job
 * no Daisy tools; Daisy returns its answer.
 *
 * Enforcement (verified with the real CLIs, Claude Code 2.1.316 and Codex
 * 0.157.1):
 *  - Claude Code: `--restricted --tools Read,Grep,Glob` — the only tools
 *    are reading files, confined to the working directory (the session's
 *    workspace / its main session's worktree); no Bash, no Web, no writes,
 *    no subagents. User / project / local settings files are ignored (their
 *    allow rules and hooks do not load; CLAUDE.md context still does);
 *    `--strict-mcp-config` with an empty `--mcp-config` drops every MCP
 *    server, claude.ai connectors included; `--permission-mode dontAsk`
 *    refuses whatever would ask; Read deny rules keep secrets out of reach
 *    (`SIDECAR_SECRET_PATHS`, the identity's config directory), which
 *    matters most for a home-directory workspace. Where the node has Bubblewrap and the
 *    workspace is a project directory, the process also runs on a
 *    read-only filesystem in which only Claude's transcript directory
 *    (`<config>/projects`) is writable — not its settings or hooks.
 *  - Codex: the thread is forked / resumed with `sandbox: "read-only"`,
 *    `approvalPolicy: "never"`, no MCP servers and no ChatGPT apps
 *    (`config: {mcp_servers: {}, "features.apps": false}`) and no web search
 *    (`web_search: "disabled"`); Daisy's dynamic
 *    tools a forked thread may carry are refused by the Runner. Codex's
 *    read-only sandbox can read the whole disk (it has no readable-roots
 *    setting) — the same reach the main session's own sandbox has, minus
 *    writes, network and escalation.
 *  - Both: any approval request a sidecar still raises is declined by the
 *    Runner itself (never shown to the owner).
 */
import { turnT } from "../harness/model-switch.ts";
import { daisyEnv } from "../../../contracts/src/env.ts";
import {
  ACP_AGENTS,
  ACP_HARNESSES,
} from "../../../contracts/src/acp-harnesses.ts";
import { createHash } from "node:crypto";
import { join, posix, resolve, win32 } from "node:path";
import { homedir } from "node:os";
import { existsSync, mkdirSync } from "node:fs";
import type { RunnerJob } from "../../../contracts/src/index.ts";
import { sidecarGuideText } from "../../../contracts/src/guide.ts";
import { sessionT } from "../../../contracts/src/prompt-i18n.ts";
import {
  askHistoryBlock,
  sideQuestionNeedsFiles,
  sideQuestionText,
  type AskVia,
} from "../../../contracts/src/ask-sidecar.ts";
import { sessionLang } from "../../../contracts/src/prompt-i18n.ts";
// P6-24: the packs for the prompts built here (side effect).
import "../prompts/lang.ts";
import { readOnlyLaunch } from "../platform/read-only.ts";
import { DATA_DIR_NAME, dataDir } from "../platform/paths.ts";
import { pluginSecretPaths } from "../plugins/runner.ts";
import { stage, type Runtime } from "../harness/shared.ts";
import type { LiveRegistry } from "./live.ts";

export const isSidecar = (job: Pick<RunnerJob, "session">) =>
  !!job.session.sidecar;

/** The only Claude Code tools a sidecar has. */
export const SIDECAR_CLAUDE_TOOLS = ["Read", "Grep", "Glob"];

/**
 * Secrets a sidecar's Read / Grep / Glob never see, also when the
 * workspace is the home directory (no Bubblewrap layer there, and
 * `--restricted` allows the whole working directory). Claude Code read
 * rules (gitignore-style; `~/` = home, `**` = anywhere; measured 2.1.316:
 * a Read deny rule also hides the files from Grep and Glob under
 * --restricted). Plus the identity's own config directory and the
 * Runner's config (`claudeSidecarArgs`).
 */
export const SIDECAR_SECRET_PATHS = [
  "~/.ssh/**",
  "~/.claude/**",
  "~/.claude.json",
  "~/.codex/**",
  // P4-10: the ACP harnesses' own directories (Kimi ~/.kimi-code).
  ...ACP_AGENTS.flatMap((a) => {
    const d = ACP_HARNESSES[a]!.configDir;
    return d ? [`~/${d.home}/**`] : [];
  }),
  "~/.config/**/credentials*",
  "~/.config/gh/**",
  // Daisy's data directory by each system's convention (database, keys,
  // runner.json, managed identity homes; the one in use is added by
  // `sidecarDenyRules`) and a Runner's default state root, also under its
  // pre-P6-03 name (ADR-153). (A plugin's own secrets: its `secretPaths`,
  // added while it is enabled — P4-13.)
  `~/.local/share/${DATA_DIR_NAME.posix}/**`,
  `~/Library/Application Support/${DATA_DIR_NAME.mac}/**`,
  `~/AppData/Local/${DATA_DIR_NAME.windows}/**`,
  "~/.local/share/daisy-runner/**",
  "~/.local/share/agent-harbor/**",
  "~/.netrc",
  "~/.git-credentials",
  "~/.aws/**",
  "~/.gnupg/**",
  "~/.docker/config.json",
  "~/.kube/**",
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/*id_rsa*",
  "**/*id_ed25519*",
  "**/runner.json",
  "**/capability.json",
];
/**
 * An absolute path as a Claude Code rule path (`//abs/…`). Windows (P5-05):
 * Claude Code matches POSIX forms — `C:\\Users\\a` is `/c/Users/a`, so the
 * rule is `//c/Users/a` (code.claude.com/docs/en/permissions).
 */
export const absRule = (p: string, platform: NodeJS.Platform = process.platform) => {
  if (platform !== "win32") return "/" + posix.resolve(p);
  const w = win32.resolve(p);
  const m = /^([A-Za-z]):[\\/]?(.*)$/.exec(w);
  return m ? `//${m[1]!.toLowerCase()}/${m[2]!.replace(/\\/g, "/")}`.replace(/\/+$/, "") : "/" + w.replace(/\\/g, "/");
};
/** The `--disallowedTools` value of a sidecar: Read deny rules for every secret path. */
export function sidecarDenyRules(
  job: Pick<RunnerJob, "profile"> & { profile: { configDir?: string } },
): string {
  const nodeConfig = daisyEnv("DAISY_NODE_CONFIG");
  const extra = [
    ...pluginSecretPaths(),
    ...(job.profile.configDir ? [`${absRule(job.profile.configDir)}/**`] : []),
    `${absRule(dataDir())}/**`,
    ...(nodeConfig ? [absRule(nodeConfig)] : []),
  ];
  return [...SIDECAR_SECRET_PATHS, ...extra].map((p) => `Read(${p})`).join(",");
}

/**
 * Claude Code arguments of a sidecar turn: read-only permissions, and on
 * its first turn the fork of the main session (`--resume <main>
 * --fork-session --session-id <own>`); later turns resume its own id.
 */
export function claudeSidecarArgs(
  job: Pick<RunnerJob, "session" | "profile">,
  nativeId: string,
): string[] {
  const sc = job.session.sidecar!;
  return [
    "--restricted",
    "--tools",
    SIDECAR_CLAUDE_TOOLS.join(","),
    "--disallowedTools",
    sidecarDenyRules(job),
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--permission-mode",
    "dontAsk",
    ...(job.session.nativeId
      ? ["--resume", nativeId]
      : (sc.mainNativeId ?? sc.forkFrom)
        ? [
            "--resume",
            (sc.mainNativeId ?? sc.forkFrom)!,
            "--fork-session",
            "--session-id",
            nativeId,
          ]
        : ["--session-id", nativeId]),
  ];
}

/**
 * the Codex thread a sidecar turn forks — the main session's
 * current thread — and whether the fork is a throwaway one per question
 * (`ephemeral`: not written to disk, not resumed; the earlier questions
 * goes into the prompt instead). null: resume the sidecar's own thread
 * (the persisted fork) or start fresh (the main has no thread).
 */
export function codexSidecarFork(
  job: Pick<RunnerJob, "session">,
): { threadId: string; ephemeral: boolean } | null {
  const sc = job.session.sidecar;
  const from = sc && (sc.mainNativeId ?? sc.forkFrom);
  if (!sc || !from) return null;
  const ephemeral = sc.native?.fork === "native";
  if (!ephemeral && job.session.nativeId) return null;
  return { threadId: from, ephemeral };
}

/** Daisy's own wait for a side question (the CLI's is 660 s). */
export const SIDE_QUESTION_MS = 180_000;
const sideQuestionMs = () =>
  Number(daisyEnv("DAISY_SIDE_QUESTION_MS")) > 0
    ? Number(daisyEnv("DAISY_SIDE_QUESTION_MS"))
    : SIDE_QUESTION_MS;

/** The route item the control plane reads (`ask-route`, input.via). */
function route(rt: Runtime, via: AskVia, text: string) {
  rt.emit("item", {
    id: `${rt.job.id}:ask-route`,
    kind: "tool",
    category: "lifecycle",
    name:
      via === "side_question"
        ? turnT()("server-turns.sidecar.route.native")
        : via === "ephemeral"
          ? turnT()("server-turns.sidecar.route.ephemeral")
          : turnT()("server-turns.sidecar.route.fork"),
    status: "complete",
    text,
    input: { via },
    createdAt: Date.now(),
  });
}

/**
 * answer a sidecar job natively when this node's agent can
 * (`session.sidecar.native`, from the node's capabilities): Claude Code's
 * `side_question` on the main session's live process. Returns true when
 * that answered (its answer is this job's last assistant text, as a
 * fork's would be). Otherwise the job forks: its prompt then
 * carries the earlier questions the fork has not seen. Falls
 * back when the main process is not up, the question has attachments
 * (a side question is text only), there is no real answer, or the answer
 * is the fixed "needs files" marker.
 */
export async function askNatively(
  rt: Runtime,
  mainLive: LiveRegistry | undefined,
): Promise<boolean> {
  const sc = rt.job.session.sidecar;
  if (!sc) return false;
  const history = sc.history || [];
  let why = "";
  if (sc.native?.sideQuestion === "native") {
    const main = mainLive?.peek(sc.parent);
    if (!main?.sideQuestion) why = turnT()("server-turns.sidecar.mainOffline");
    else if (main.canAsk && !main.canAsk()) why = turnT()("server-turns.sidecar.mainStarting");
    else if (rt.files.length) why = turnT()("server-turns.sidecar.hasFiles");
    else {
      stage(rt, "ask-native", turnT()("server-turns.sidecar.asking"), "running");
      // The earlier questions go in quoted (review M1), not as
      // side_question `history` turns.
      const lang = sessionLang(rt.job.session);
      const asked = sideQuestionText(askHistoryBlock(history, lang) + rt.prompt, lang);
      // What the main session's process is asked, as sent
      // (a job with the layered prompt only).
      if (sidecarGuide(rt.job) !== sidecarGuideNote(rt.job)) rt.emit("item", {
        id: `${rt.job.id}:prompt-audit:side-question`,
        kind: "tool",
        category: "audit",
        name: turnT()("server-turns.audit.sideQuestion"),
        status: "complete",
        text: asked,
        createdAt: Date.now(),
        input: {
          role: "user",
          systemPromptOverride: false,
          sideQuestion: true,
          sha256: createHash("sha256").update(asked).digest("hex"),
        },
      });
      const answer = await main.sideQuestion(
        asked,
        [],
        { signal: rt.signal, timeoutMs: sideQuestionMs() },
      );
      if (rt.signal.aborted) throw Error(turnT()("server-turns.sidecar.stopped"));
      if (answer && !sideQuestionNeedsFiles(answer)) {
        stage(
          rt,
          "ask-native",
          turnT()("server-turns.sidecar.answered"),
        );
        route(rt, "side_question", "");
        rt.emit("item", {
          id: `${rt.job.id}:side-answer`,
          kind: "assistant",
          text: answer,
          status: "complete",
          createdAt: Date.now(),
        });
        await rt.flush();
        return true;
      }
      why = answer ? turnT()("server-turns.sidecar.needsFiles") : turnT()("server-turns.sidecar.noAnswer");
      stage(rt, "ask-native", turnT()("server-turns.sidecar.fallback", { why }));
    }
  }
  const ephemeral = !!codexSidecarFork(rt.job)?.ephemeral;
  const fresh = ephemeral || !rt.job.session.nativeId;
  rt.prompt =
    askHistoryBlock(fresh ? history : history.filter((h) => h.via !== "fork"), sessionLang(rt.job.session)) +
    rt.prompt;
  route(rt, ephemeral ? "ephemeral" : "fork", why);
  return false;
}

/** Codex thread settings of a sidecar (fork, start and resume alike). */
export const CODEX_SIDECAR = {
  sandbox: "read-only",
  approvalPolicy: "never",
  approvalsReviewer: "user",
  // Measured 0.157.1: replaces the MCP server map (→ none) and turns the
  // ChatGPT apps server (codex_apps) off, on thread/start and thread/fork.
  // web_search "disabled": no built-in web search either (the key and
  // its values are Codex's own: "disabled" | "cached" | "indexed" | "live").
  config: { mcp_servers: {}, "features.apps": false, web_search: "disabled" },
} as const;

/**
 * A Codex sidecar calling one of Daisy's tools (a forked thread still
 * lists them). P4N-4: only Daisy's tools are off — reading is not: the
 * model's own commands still read files in the read-only sandbox.
 */
export const sidecarToolRefusal = (lang?: string | null) => turnT(lang)("server-turns.sidecar.toolRefusal");

/** The sidecar's built-in note (Codex developer instructions / Claude system prompt). */
export const sidecarGuideNote = (job: Pick<RunnerJob, "session">) => sidecarGuideText(sessionT(job.session));
/**
 * What a sidecar is launched with: the control plane's layered
 * text for it (the core's intro and red lines, this note, the safety
 * rules); else the note alone.
 */
export function sidecarGuide(job: Pick<RunnerJob, "guide" | "session">): string {
  const g = job.guide;
  return g && g.v === 2 && typeof g.text === "string" && g.text.trim()
    ? g.text
    : sidecarGuideNote(job);
}

/** Where Claude Code keeps transcripts for this identity. */
const claudeProjects = (job: RunnerJob) =>
  join(job.profile.configDir || resolve(homedir(), ".claude"), "projects");

/**
 * The read-only filesystem a sidecar runs on when it can (Bubblewrap, a
 * project directory): only the transcript directory stays writable.
 * `undefined`: not available here — the provider's own rules hold alone.
 */
export function sidecarLaunch(job: RunnerJob, cwd: string) {
  // Tests with fake CLIs that record into the workspace turn the layer off.
  if (daisyEnv("DAISY_SIDECAR_BWRAP") === "0") return undefined;
  try {
    const projects = claudeProjects(job);
    if (!existsSync(projects))
      mkdirSync(projects, { recursive: true, mode: 0o700 });
    return readOnlyLaunch(
      { ...job, session: { ...job.session, workspaceMode: "read-only" } },
      cwd,
      { writable: [projects] },
    );
  } catch {
    return undefined;
  }
}

/**
 * The decision a sidecar gives an approval request by itself: the
 * provider's decline option (never asks the owner); null when it offers
 * none (the turn then fails rather than guess).
 */
export function sidecarDecline(options: { id: string }[]) {
  return (
    options.find((o) => /^(deny|decline|reject)/i.test(o.id))?.id ??
    options.find((o) => /cancel|abort/i.test(o.id))?.id ??
    null
  );
}
