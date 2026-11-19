import type { Session } from "./session.ts";
import type { MessageKey } from "./i18n-keys.gen.ts";
import { LEGACY_PROMPT_LANG, promptT, type PromptT } from "./prompt-i18n.ts";
/**
 * Which of Daisy's own tools a Codex thread has (P4N-3).
 *
 * Codex takes client tools (`dynamicTools`) only on `thread/start`: a
 * thread keeps the set it was started with, and resume / fork cannot add
 * to it. Daisy records the names at start (`session.nativeTools.names`);
 * a thread started without tools has no record. A record from before the
 * names were kept (`version` 1, no `names`) is only sure of the set that
 * existed when tools first came (the timers and background work, and
 * `say` for a resident): anything added since is "maybe missing".
 *
 * The names here are the tools' bare names (Codex sees `daisy_<name>`, or
 * `harbor_<name>` on a thread started before ADR-154 — `toolId`);
 * `packages/daisy/src/tools/daisy-tools.ts` holds their specs and a test
 * keeps the two lists equal.
 */
export const SCHEDULER_TOOL_NAMES = [
  "wakeup",
  "cron",
  "bash",
  "monitor",
  "output",
  "schedules",
  "cancel",
] as const;
/** P4-08 (ADR-127): calling agents on other Daisys. */
export const A2A_TOOL_NAMES = ["agents", "call_agent", "call_result"] as const;
/**
 * ADR-154 (P6-04): the version of Daisy's tool set. 2: the tools go by
 * Daisy's name — Claude Code's MCP server `daisy` (`mcp__daisy__<name>`),
 * Codex's dynamic tools `daisy_<name>`. 1 (before): the old product name —
 * server `harbor` (`mcp__harbor__<name>`), `harbor_<name>`. It is
 *
 *   - the Runner's capability `daisyTools.version` (it serves both names);
 *   - `RunnerJob.daisyTools.version`;
 *   - the version a native conversation's record says it was started with
 *     (`session.nativeTools.version`).
 */
export const DAISY_TOOLSET_VERSION = 2;
/** The MCP server / prefix Daisy's tools go by (ADR-154). */
export const TOOL_SERVER = "daisy";
/** …and went by before ADR-154: a conversation started then keeps it. */
export const LEGACY_TOOL_SERVER = "harbor";
/**
 * Which names a conversation knows Daisy's tools by: "daisy" — the
 * current ones; "legacy" — the names a native conversation started before
 * ADR-154 was given (its history and the system prompt the engine
 * recorded name them), still served to it so its tools keep working.
 */
export type ToolNames = "daisy" | "legacy";
export const toolServer = (names: ToolNames = "daisy") =>
  names === "legacy" ? LEGACY_TOOL_SERVER : TOOL_SERVER;
/** A tool's id as `agent` sees it: `mcp__daisy__wakeup` (Claude Code), `daisy_wakeup` (Codex). */
export function toolId(agent: string, bare: string, names: ToolNames = "daisy"): string {
  const server = toolServer(names);
  return agent === "claude" ? `mcp__${server}__${bare}` : `${server}_${bare}`;
}
/**
 * The bare name of a Daisy tool id in either spelling (`daisy_x`,
 * `harbor_x`, `mcp__daisy__x`, `mcp__harbor__x`), or a bare name as it is.
 */
export function bareToolName(id: string): string {
  return String(id || "").replace(
    new RegExp(`^(?:mcp__(?:${TOOL_SERVER}|${LEGACY_TOOL_SERVER})__|(?:${TOOL_SERVER}|${LEGACY_TOOL_SERVER})_)`),
    "",
  );
}
/**
 * The names this session's native conversation knows Daisy's tools by,
 * from what was recorded when it started (ADR-154):
 *
 *   - no native conversation yet: the current names (a new one gets them);
 *   - Codex: the record of this thread — version 2 the current names, 1 the
 *     old ones (Codex keeps a thread's tools as they were at its start). No
 *     record: the thread has no Daisy tools at all; the current names;
 *   - Claude Code: its tools are listed anew at every launch, but a resumed
 *     conversation keeps the system prompt the engine recorded and its
 *     history names the tools: a session that recorded version 2 (at any
 *     point: a rewind gives it a new native id, same conversation) the
 *     current names; one with no record — started before ADR-154 — the old.
 */
export function sessionToolNames(
  s: Pick<Session, "agent" | "nativeId" | "nativeTools">,
): ToolNames {
  if (!s.nativeId) return "daisy";
  const rec = s.nativeTools;
  if (s.agent === "claude")
    return rec && rec.version >= DAISY_TOOLSET_VERSION ? "daisy" : "legacy";
  if (s.agent === "codex" && rec?.thread === s.nativeId)
    return rec.version >= DAISY_TOOLSET_VERSION ? "daisy" : "legacy";
  return "daisy";
}
/**
 * The names a job of `s` uses, given what its node's Runner declared
 * (`capabilities`): a Runner before ADR-154 serves only the old names.
 */
export function toolNamesFor(
  s: Pick<Session, "agent" | "nativeId" | "nativeTools">,
  runnerCapabilities: any,
): ToolNames {
  return runnerCapabilities?.daisyTools?.version >= DAISY_TOOLSET_VERSION
    ? sessionToolNames(s)
    : "legacy";
}
/**
 * ADR-154: the `RunnerJob` fields that give a job of `s` Daisy's
 * tools — `daisyTools` (with `legacyNames` for a conversation started by
 * the old ones) to a Runner that serves both; `harborTools` to a Runner
 * before ADR-154, which reads only that field and serves the old names.
 */
export function jobToolsField(
  s: Pick<Session, "agent" | "nativeId" | "nativeTools">,
  runnerCapabilities: any,
): { daisyTools: { version: number; legacyNames?: boolean } } | { harborTools: { version: number } } {
  if (!(runnerCapabilities?.daisyTools?.version >= DAISY_TOOLSET_VERSION))
    return { harborTools: { version: 1 } };
  return {
    daisyTools: {
      version: DAISY_TOOLSET_VERSION,
      ...(sessionToolNames(s) === "legacy" ? { legacyNames: true } : {}),
    },
  };
}
/** What a thread recorded as `version` 1 without names surely has. */
const V1_SURE: readonly string[] = [...SCHEDULER_TOOL_NAMES, "say"];
/** The tools Daisy gives a session of this kind now (when it gives tools). */
export function daisyToolNames(kind: Session["kind"] | undefined): string[] {
  return kind === "resident"
    ? [...SCHEDULER_TOOL_NAMES, ...A2A_TOOL_NAMES, "say"]
    : [...SCHEDULER_TOOL_NAMES, ...A2A_TOOL_NAMES];
}
/** Plain names for the owner (never colour or a tool id alone): message keys. */
export const DAISY_TOOL_LABEL_KEY: Record<string, MessageKey> = {
  wakeup: "prompt-native.label.wakeup",
  cron: "prompt-native.label.cron",
  bash: "prompt-native.label.bash",
  monitor: "prompt-native.label.monitor",
  output: "prompt-native.label.output",
  schedules: "prompt-native.label.schedules",
  cancel: "prompt-native.label.cancel",
  say: "prompt-native.label.say",
  agents: "prompt-native.label.agents",
  call_agent: "prompt-native.label.call_agent",
  call_result: "prompt-native.label.call_result",
};
export interface MissingTools {
  /** Bare names of `wanted` the thread lacks (or may lack). */
  names: string[];
  /** false: the thread's set was not recorded — "may lack". */
  sure: boolean;
}
/**
 * Of the tools Daisy would give now (`wanted`), the ones this session's
 * Codex thread lacks. Not Codex, or no thread yet (a new one gets them
 * all): none.
 */
export function missingThreadTools(
  s: Pick<Session, "agent" | "nativeId" | "nativeTools">,
  wanted: readonly string[],
): MissingTools {
  if (s.agent !== "codex" || !s.nativeId || !wanted.length)
    return { names: [], sure: true };
  const rec =
    s.nativeTools?.thread === s.nativeId && s.nativeTools.version >= 1
      ? s.nativeTools
      : null;
  const has: readonly string[] = !rec
    ? []
    : Array.isArray(rec.names)
      ? rec.names
      : V1_SURE;
  return {
    names: wanted.filter((n) => !has.includes(n)),
    sure: !rec || Array.isArray(rec.names),
  };
}
const list = (names: string[], f: (n: string) => string, t: PromptT) =>
  names.map(f).join(t("prompt-native.listSep"));
/**
 * The line for the model (developer instructions / layered prompt): which
 * Daisy tools this thread does not have, so it does not pretend. In the
 * session's language (P6-24).
 */
export function missingToolsText(
  m: MissingTools,
  toolNames: ToolNames = "daisy",
  t: PromptT = promptT(LEGACY_PROMPT_LANG),
): string {
  if (!m.names.length) return "";
  const names = list(m.names, (n) => toolId("codex", n, toolNames), t);
  return t(m.sure ? "prompt-native.missing.sure" : "prompt-native.missing.maybe", { names });
}
/** The one-time notice the owner sees in that conversation (the session's language). */
export function missingToolsNotice(m: MissingTools, t: PromptT = promptT(LEGACY_PROMPT_LANG)): string {
  if (!m.names.length) return "";
  const names = list(m.names, (n) => (DAISY_TOOL_LABEL_KEY[n] ? t.dynamic(DAISY_TOOL_LABEL_KEY[n]) : n), t);
  return t(m.sure ? "prompt-native.notice.sure" : "prompt-native.notice.maybe", { names });
}
