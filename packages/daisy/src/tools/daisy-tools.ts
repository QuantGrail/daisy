import { daisyEnv } from "../../../contracts/src/env.ts";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { defaultStateRoot } from "../platform/paths.ts";
import type {
  DaisySchedule,
  RunnerJob,
} from "../../../contracts/src/index.ts";
import { SCHEDULE_LIMITS } from "../../../contracts/src/scheduler.ts";
import {
  residentPromptSections,
  residentPromptText,
} from "../../../contracts/src/resident-prompt.ts";
import { timersText } from "../../../contracts/src/guide.ts";
import {
  bareToolName,
  missingThreadTools,
  missingToolsText,
  toolId,
  toolServer,
  type ToolNames,
} from "../../../contracts/src/native-tools.ts";
import { readOnlyLaunch } from "../platform/read-only.ts";
import type { BackgroundManager } from "../schedule/background.ts";
import { agentEnv, liveFeatures, type Runtime } from "../harness/shared.ts";
import { promptRefreshAt } from "../../../contracts/src/agent-capabilities.ts";
import { LEGACY_PROMPT_LANG, promptT, sessionT, type PromptT } from "../../../contracts/src/prompt-i18n.ts";
// P6-24: the language packs, loaded for the prompt builders.
import "../prompts/lang.ts";
/**
 * Daisy's tools for the Agent: timers and background work the
 * control plane keeps, plus `say` for a 「任务常驻 Agent」. Claude Code gets
 * them as the in-process MCP server "daisy" (control protocol
 * `mcp_message`, tools `mcp__daisy__<name>`); Codex as dynamic tools
 * (`daisy_<name>`, thread/start `dynamicTools`, `item/tool/call`). Both are
 * served by the Runner itself — no CLI, no network from inside the sandbox.
 * ADR-154: a conversation started before by the old names (server
 * "harbor", `harbor_<name>`) is served those (`jobToolNames`).
 */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
const str = (description: string, extra: Record<string, unknown> = {}) => ({
  type: "string",
  description,
  ...extra,
});
const int = (description: string, min: number, max: number) => ({
  type: "integer",
  description,
  minimum: min,
  maximum: max,
});
/** P6-24: in the session's language (`sessionT`). */
const SCHEDULER = (t: PromptT): ToolSpec[] => [
  {
    name: "wakeup",
    description: t("prompt-tools.wakeup.description"),
    inputSchema: {
      type: "object",
      properties: {
        delaySeconds: int(
          t("prompt-tools.wakeup.delaySeconds", { min: SCHEDULE_LIMITS.minDelaySeconds }),
          SCHEDULE_LIMITS.minDelaySeconds,
          SCHEDULE_LIMITS.maxDelaySeconds,
        ),
        prompt: str(t("prompt-tools.wakeup.prompt")),
        reason: str(t("prompt-tools.param.listLabel")),
      },
      required: ["delaySeconds", "prompt"],
    },
  },
  {
    name: "cron",
    description: t("prompt-tools.cron.description", { max: SCHEDULE_LIMITS.cronMaxDays }),
    inputSchema: {
      type: "object",
      properties: {
        cron: str(t("prompt-tools.cron.cron")),
        prompt: str(t("prompt-tools.cron.prompt")),
        label: str(t("prompt-tools.param.listLabel")),
        recurring: { type: "boolean", description: t("prompt-tools.cron.recurring") },
        expiresInDays: int(
          t("prompt-tools.cron.expiresInDays"),
          1,
          SCHEDULE_LIMITS.cronMaxDays,
        ),
      },
      required: ["cron", "prompt"],
    },
  },
  {
    name: "bash",
    description: t("prompt-tools.bash.description"),
    inputSchema: {
      type: "object",
      properties: {
        command: str(t("prompt-tools.param.command")),
        description: str(t("prompt-tools.bash.what")),
        timeoutSeconds: int(
          t("prompt-tools.bash.timeoutSeconds"),
          5,
          SCHEDULE_LIMITS.backgroundMaxSeconds,
        ),
      },
      required: ["command", "description"],
    },
  },
  {
    name: "monitor",
    description: t("prompt-tools.monitor.description", {
      seconds: SCHEDULE_LIMITS.monitorMinIntervalMs / 1000,
    }),
    inputSchema: {
      type: "object",
      properties: {
        command: str(t("prompt-tools.param.command")),
        description: str(t("prompt-tools.monitor.what")),
        pattern: str(t("prompt-tools.monitor.pattern")),
        timeoutSeconds: int(
          t("prompt-tools.monitor.timeoutSeconds"),
          5,
          SCHEDULE_LIMITS.backgroundMaxSeconds,
        ),
      },
      required: ["command", "description"],
    },
  },
  {
    name: "output",
    description: t("prompt-tools.output.description"),
    inputSchema: {
      type: "object",
      properties: {
        id: str(t("prompt-tools.output.id")),
        chars: int(t("prompt-tools.output.chars"), 200, 60000),
      },
      required: ["id"],
    },
  },
  {
    name: "schedules",
    description: t("prompt-tools.schedules.description"),
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "cancel",
    description: t("prompt-tools.cancel.description"),
    inputSchema: {
      type: "object",
      properties: { id: str(t("prompt-tools.cancel.id")) },
      required: ["id"],
    },
  },
];
/**
 * P1-01: `say` is a resident's (常驻 Agent) only; residents are off until
 * stage 4 rebuilds them, so no turn gets this tool in stage 1.
 */
const SAY = (t: PromptT): ToolSpec => ({
  name: "say",
  description: t("prompt-tools.say.description"),
  inputSchema: {
    type: "object",
    properties: { text: str(t("prompt-tools.say.text")) },
    required: ["text"],
  },
});
/**
 * P4-08 (ADR-127, D-17, 5.11 「调用别的智能体」: the AI's own tools): calling
 * an agent on another Daisy — 发现智能体 / 调用智能体 / 查询调用结果. Daisy
 * makes the call as this AI (its own signed token), keeps the other side's
 * contextId / taskId, and wakes the AI once when the answer is back.
 */
const A2A_TOOLS = (t: PromptT): ToolSpec[] => [
  {
    name: "agents",
    description: t("prompt-tools.agents.description"),
    inputSchema: {
      type: "object",
      properties: { contact: str(t("prompt-tools.agents.contact")) },
    },
  },
  {
    name: "call_agent",
    description: t("prompt-tools.callAgent.description"),
    inputSchema: {
      type: "object",
      properties: {
        contact: str(t("prompt-tools.callAgent.contact")),
        agent: str(t("prompt-tools.callAgent.agent")),
        text: str(t("prompt-tools.callAgent.text")),
        mode: { type: "string", enum: ["ask", "act"], description: t("prompt-tools.callAgent.mode") },
        continue: { type: "boolean", description: t("prompt-tools.callAgent.continue") },
        replyTo: str(t("prompt-tools.callAgent.replyTo")),
      },
      required: ["text"],
    },
  },
  {
    name: "call_result",
    description: t("prompt-tools.callResult.description"),
    inputSchema: {
      type: "object",
      properties: { callId: str(t("prompt-tools.callResult.callId")) },
    },
  },
];
/**
 * ADR-154: the names this job's Agent gets Daisy's tools by — the control
 * plane says (`daisyTools`, `legacyNames` for a conversation started with
 * the old ones); one before ADR-154 sends `harborTools`: the old names
 * (its text names them so). null: no Daisy tools.
 */
export function jobToolNames(
  job: Pick<RunnerJob, "daisyTools" | "harborTools">,
): ToolNames | null {
  if (job.daisyTools) return job.daisyTools.legacyNames ? "legacy" : "daisy";
  return job.harborTools ? "legacy" : null;
}
type ToolJob = Pick<RunnerJob, "daisyTools" | "harborTools" | "session">;
/** Tools for this job's Agent: none without a control plane that runs the scheduler. */
export function toolsFor(job: ToolJob) {
  if (!jobToolNames(job)) return [];
  // P6-24: described in the session's language (ADR-159 §6).
  const t = sessionT(job.session);
  return job.session.kind === "resident"
    ? [...SCHEDULER(t), ...A2A_TOOLS(t), SAY(t)]
    : [...SCHEDULER(t), ...A2A_TOOLS(t)];
}
/**
 * Claude Code: these run without asking (no side effects outside Daisy).
 * Background commands go through its own permission check, like Bash; so
 * does call_agent (P4-08: it sends this AI's words to someone else).
 * Bare names (`claudeAllowed` gives the ids).
 */
export const CLAUDE_ALLOWED = [
  "wakeup",
  "cron",
  "output",
  "schedules",
  "cancel",
  "say",
  "agents",
  "call_result",
];
/** `--allowedTools` ids of `tools` that run without asking, by the server they are served as. */
export function claudeAllowed(tools: { name: string }[], names: ToolNames) {
  return CLAUDE_ALLOWED.filter((n) => tools.some((t) => t.name === n)).map(
    (n) => toolId("claude", n, names),
  );
}
/** The MCP server name Claude Code gets Daisy's tools from for this job. */
export const claudeToolServer = (job: Pick<RunnerJob, "daisyTools" | "harborTools">) =>
  toolServer(jobToolNames(job) ?? "daisy");
/** The per-turn line about Daisy's tools (non-resident sessions; the resident guide says more). */
export function toolsNote(agent: string, toolNames: ToolNames = "daisy", t: PromptT = promptT(LEGACY_PROMPT_LANG)) {
  // One text for the older launch note and the layered prompt's section.
  return "\n\n" + timersText(agent, toolNames, t);
}
/**
 * The built-in guidance of a 「任务常驻 Agent」 (system prompt / developer
 * instructions). The control plane writes it (`residentGuide`:
 * its owner's changes); from an older control plane,
 * the same sections built from the session alone.
 */
export function residentGuide(
  job: Pick<RunnerJob, "session" | "daisyTools" | "harborTools"> & {
    residentGuide?: string;
  },
): string {
  const s = job.session;
  if (s.kind !== "resident" || !s.resident) return "";
  if (typeof job.residentGuide === "string" && job.residentGuide.trim())
    return job.residentGuide;
  return residentPromptText(
    residentPromptSections(s, { toolNames: jobToolNames(job) ?? "daisy" }),
  );
}
/**
 * the layered prompt the control plane composed for this job, if
 * this is one (a control plane that has it, for a Runner that declared
 * `promptLayers`).
 */
export function layeredGuide(job: Pick<RunnerJob, "guide">) {
  const g = job.guide;
  return g && g.v === 2 && typeof g.text === "string" && g.text.trim()
    ? g
    : null;
}
/**
 * What a process is launched with (system prompt / developer instructions).
 * the control plane's layered text as is. Else (an older control
 * plane, or the layers switched off): a resident's guidance, else the short
 * note on Daisy's tools — for Codex only on a thread that has them
 * (started with them, or new).
 */
export function launchGuide(
  job: Pick<
    RunnerJob,
    "session" | "daisyTools" | "harborTools" | "residentGuide" | "guide"
  >,
) {
  const layered = layeredGuide(job);
  if (layered) return layered.text;
  const resident = residentGuide(job);
  if (resident) return resident;
  const tools = toolsFor(job);
  if (!tools.length) return "";
  const s = job.session;
  // Codex: a thread keeps the tools it started with (P4N-3) — the note on
  // timers only where it has them, and a line on what it lacks.
  const missing = missingThreadTools(
    s,
    tools.map((t) => t.name),
  );
  const names = jobToolNames(job) ?? "daisy";
  return [
    missing.names.includes("wakeup") ? "" : toolsNote(s.agent, names, sessionT(s)).trim(),
    missingToolsText(missing, names, sessionT(s)),
  ]
    .filter(Boolean)
    .join("\n\n");
}
/**
 * What a process is keyed on: `guide.stable` — an L1 update
 * of the org core alone does not restart it — else the launch text itself.
 */
export function launchGuideKey(
  job: Pick<
    RunnerJob,
    "session" | "daisyTools" | "harborTools" | "residentGuide" | "guide"
  >,
) {
  const layered = layeredGuide(job);
  return layered
    ? `g2:${layered.stable}`
    : createHash("sha256").update(launchGuide(job)).digest("hex").slice(0, 16);
}
/**
 * An experiment that is off unless the control plane says so for
 * this session: launch Claude Code with `--system-prompt-snapshot off`
 * (the system prompt rendered afresh at every request) — only on a CLI
 * version it was measured on.
 */
export function freshLaunch(job: Pick<RunnerJob, "session" | "guide">) {
  const g = layeredGuide(job);
  return (
    !!g?.fresh &&
    job.session.agent === "claude" &&
    !job.session.sidecar &&
    promptRefreshAt("claude", liveFeatures("claude")?.cliVersion)
  );
}
/**
 * may this turn carry the short collaboration line? Only when the
 * static rules are in the system layer the model really has: a new native
 * session (launched with this text), or one the Runner reported the
 * layered prompt for (`nativeGuide`) in a way that still holds — recorded
 * by the engine or injected into the thread; rendered afresh only while
 * this launch renders afresh too (switch that off and a Claude session is
 * back on what it recorded before). See docs/prompt-layers-stage0: an
 * older Claude session keeps its recorded system prompt, a resumed Codex
 * thread its first developer instructions. Otherwise the full note stays
 * in the turn: never neither.
 */
export function staticRulesDelivered(
  job: Pick<RunnerJob, "session" | "guide">,
) {
  const g = layeredGuide(job);
  if (!g?.staticRules) return false;
  const s = job.session;
  if (!s.nativeId) return true;
  const d = s.nativeGuide;
  if (!d || d.thread !== s.nativeId || d.staticRules !== true) return false;
  return d.via === "record" || d.via === "inject"
    ? true
    : d.via === "fresh" && freshLaunch(job);
}
/** What the Agent sees as a tool result. */
export interface ToolResult {
  ok: boolean;
  text: string;
}
type Api = (path: string, body?: any) => Promise<any>;
const when = (t: PromptT, ms?: number | null) =>
  ms ? new Date(ms).toLocaleString(t.lang, { hour12: false }) : "—";
/** One schedule in the list the Agent reads (the session's language). */
function line(t: PromptT, s: DaisySchedule) {
  const kind = t.dynamic(`prompt-tools.kind.${s.kind}`);
  const why = s.endedReason || "";
  const state = {
    active: s.nextAt ? t("prompt-tools.state.next", { when: when(t, s.nextAt) }) : t("prompt-tools.state.waiting"),
    running: t("prompt-tools.state.running", { when: when(t, s.nextAt) }),
    done: t("prompt-tools.state.done"),
    failed: t("prompt-tools.state.failed", {
      why: why || t("prompt-tools.state.exitCode", { code: String(s.exitCode) }),
    }),
    canceled: t("prompt-tools.state.canceled", { why }),
    expired: t("prompt-tools.state.expired"),
    lost: why ? t("prompt-tools.state.lostWhy", { why }) : t("prompt-tools.state.lost"),
    paused: t("prompt-tools.state.paused"),
  }[s.status];
  // a report kept for later (queue full, budget, monitor interval).
  const u = s.undelivered;
  const kept = u
    ? t("prompt-tools.kept", {
        reason: t.dynamic(`prompt-tools.kept.${u.reason}`),
        retry: u.retryAt ? t("prompt-tools.kept.retry", { when: when(t, u.retryAt) }) : "",
      })
    : "";
  return `- ${s.id} · ${kind} · ${s.label}${s.cron ? ` · cron ${s.cron}` : ""}${s.command ? ` · $ ${s.command.slice(0, 120)}` : ""} · ${state}${s.fires ? t("prompt-tools.fires", { n: s.fires }) : ""}${kept}`;
}
/**
 * Serves the Agent's calls of Daisy's tools for the Runner's jobs: timers
 * via the control plane, background work on this machine.
 */
export class DaisyToolHost {
  constructor(
    private api: Api,
    private background: BackgroundManager,
    private stateRoot: string = defaultStateRoot(),
  ) {}
  /** The prefix that gives a background command the protection the Agent's own commands have. */
  wrapFor(job: RunnerJob, cwd: string): string[] {
    // Read-only / snapshot (reviews 2026-11-03): nothing writable but the
    // private temp dir — not ~/.codex (a config written there would run
    // outside any sandbox at the next launch) — and no network. One bwrap
    // only: a nested `codex sandbox` cannot make its namespace under
    // Ubuntu's apparmor bwrap-userns-restrict.
    const ro = readOnlyLaunch(job, cwd, {
      providerState: false,
      network: false,
    });
    if (ro) return ["/usr/bin/bwrap", ...ro];
    if (job.session.agent === "codex") {
      const mode = job.profile.sandboxMode || "workspace-write";
      if (mode !== "danger-full-access")
        return [
          daisyEnv("DAISY_CODEX_BIN") || "codex",
          "sandbox",
          "-P",
          mode === "read-only" ? ":read-only" : ":workspace",
          "-C",
          cwd,
          "--",
        ];
    }
    return [];
  }
  /**
   * `originJob`: the turn that made this call (default: `rt`'s). A late
   * call (a background subagent after its turn ended) names its own turn,
   * not the one it is served in — sent as `jobId` with every schedule it
   * creates (the timer speaks for that turn).
   */
  async call(
    rt: Runtime,
    name: string,
    args: any,
    originJob: string = rt.job.id,
  ): Promise<ToolResult> {
    const sid = rt.job.session.id,
      a = args && typeof args === "object" ? args : {};
    // P6-24: results in the session's language.
    const t = sessionT(rt.job.session);
    // ADR-154: by either name (`daisy_x`, `harbor_x`, `mcp__…__x`, bare).
    name = bareToolName(name);
    try {
      switch (name) {
        case "wakeup": {
          const { schedule: s } = await this.api(`/sessions/${sid}/schedules`, {
            jobId: originJob,
            kind: "wakeup",
            delaySeconds: Number(a.delaySeconds),
            prompt: String(a.prompt ?? ""),
            reason: String(a.reason ?? ""),
          });
          return {
            ok: true,
            text: t("prompt-tools.result.wakeup", { id: s.id, when: when(t, s.nextAt) }),
          };
        }
        case "cron": {
          const { schedule: s } = await this.api(`/sessions/${sid}/schedules`, {
            jobId: originJob,
            kind: "cron",
            cron: String(a.cron ?? ""),
            prompt: String(a.prompt ?? ""),
            label: String(a.label ?? ""),
            ...(typeof a.recurring === "boolean"
              ? { recurring: a.recurring }
              : {}),
            ...(a.expiresInDays !== undefined
              ? { expiresInDays: Number(a.expiresInDays) }
              : {}),
          });
          return {
            ok: true,
            text: t("prompt-tools.result.cron", {
              id: s.id,
              cron: s.cron,
              next: when(t, s.nextAt),
              ends: s.expiresAt ? t("prompt-tools.result.cronEnds", { when: when(t, s.expiresAt) }) : "",
            }),
          };
        }
        case "bash":
        case "monitor": {
          // Codex "untrusted" asks before every command; so does this one.
          if (
            rt.job.session.agent === "codex" &&
            rt.job.profile.permissionMode === "untrusted"
          ) {
            const d = await rt.approve(
              name === "bash" ? t("prompt-tools.approve.bash") : t("prompt-tools.approve.monitor"),
              { command: a.command, description: a.description },
              [
                { id: "allow", label: t("prompt-tools.approve.allow") },
                { id: "deny", label: t("prompt-tools.approve.deny") },
              ],
            );
            if (d.optionId !== "allow")
              return { ok: false, text: t("prompt-tools.result.bashDenied") };
          }
          // this node's own cap, or a restart about to stop it.
          const refused = this.background.refusal?.();
          if (refused) return { ok: false, text: t("prompt-tools.result.refused", { why: refused }) };
          // The protection first (review 2026-11-03): a node that cannot
          // give it creates no row (nothing for a restart to report lost).
          let wrap: string[];
          try {
            wrap = this.wrapFor(rt.job, rt.cwd);
          } catch (e: any) {
            return { ok: false, text: t("prompt-tools.result.refused", { why: String(e?.message || e) }) };
          }
          const { schedule: s } = await this.api(`/sessions/${sid}/schedules`, {
            jobId: originJob,
            kind: name,
            command: String(a.command ?? ""),
            description: String(a.description ?? ""),
            ...(a.timeoutSeconds !== undefined
              ? { timeoutSeconds: Number(a.timeoutSeconds) }
              : {}),
            ...(name === "monitor" && a.pattern
              ? { pattern: String(a.pattern) }
              : {}),
          });
          const logPath = join(
            this.stateRoot,
            "runtime",
            sid,
            "background",
            `${s.id}.log`,
          );
          this.background.start({
            id: s.id,
            sessionId: sid,
            kind: name,
            command: s.command,
            cwd: rt.cwd,
            env: agentEnv(rt.job),
            wrap,
            timeoutMs: Math.max(5000, (s.nextAt || 0) - Date.now()),
            ...(s.pattern ? { pattern: s.pattern } : {}),
            logPath,
          });
          return {
            ok: true,
            text:
              name === "bash"
                ? t("prompt-tools.result.bash", { id: s.id, path: logPath })
                : t("prompt-tools.result.monitor", { id: s.id, path: logPath }),
          };
        }
        case "output": {
          const out = this.background.output(
            String(a.id ?? ""),
            Number(a.chars) || 4000,
            sid,
          );
          if (!out)
            return {
              ok: false,
              text: t("prompt-tools.result.outputMissing"),
            };
          return {
            ok: true,
            text:
              t("prompt-tools.result.output", {
                state: out.running ? t("prompt-tools.result.outputRunning") : t("prompt-tools.result.outputEnded"),
                bytes: out.bytes,
                path: out.path,
              }) + `\n${out.text}`,
          };
        }
        case "schedules": {
          const { schedules } = await this.api(
            `/sessions/${sid}/schedules/list`,
            {},
          );
          return {
            ok: true,
            text: schedules.length
              ? (schedules as DaisySchedule[]).map((x) => line(t, x)).join("\n")
              : t("prompt-tools.result.noSchedules"),
          };
        }
        case "cancel": {
          const scid = String(a.id ?? "");
          const { schedule: s } = await this.api(
            `/sessions/${sid}/schedules/${encodeURIComponent(scid)}/cancel`,
            {},
          );
          this.background.kill(scid, t("prompt-tools.result.killed"), true);
          return { ok: true, text: t("prompt-tools.result.canceled", { line: line(t, s).slice(2) }) };
        }
        // P4-08: the A2A client tools — answered by the control plane (a2a/outgoing.ts).
        case "agents":
        case "call_result": {
          const r = await this.api(
            `/sessions/${sid}/a2a/${name === "agents" ? "agents" : "result"}`,
            { jobId: originJob, ...a },
          );
          return { ok: r?.ok !== false, text: String(r?.text ?? "") };
        }
        case "call_agent": {
          // Codex "untrusted" asks before every command; so does a call out.
          if (
            rt.job.session.agent === "codex" &&
            rt.job.profile.permissionMode === "untrusted"
          ) {
            const d = await rt.approve(
              t("prompt-tools.approve.callAgent"),
              { contact: a.contact, agent: a.agent, mode: a.mode, text: a.text },
              [
                { id: "allow", label: t("prompt-tools.approve.allow") },
                { id: "deny", label: t("prompt-tools.approve.deny") },
              ],
            );
            if (d.optionId !== "allow")
              return { ok: false, text: t("prompt-tools.result.callDenied") };
          }
          const r = await this.api(`/sessions/${sid}/a2a/call`, {
            jobId: originJob,
            ...a,
          });
          return { ok: r?.ok !== false, text: String(r?.text ?? "") };
        }
        case "say": {
          await this.api(`/sessions/${sid}/say`, {
            text: String(a.text ?? ""),
            jobId: rt.job.id,
          });
          return { ok: true, text: t("prompt-tools.result.said") };
        }
        default:
          return { ok: false, text: t("prompt-tools.result.unknownTool", { name }) };
      }
    } catch (e: any) {
      const msg = String(e?.message || e).slice(0, 1000);
      return { ok: false, text: e?.status === 404 ? t("prompt-tools.result.notFound", { msg }) : msg };
    }
  }
}
