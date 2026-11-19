/**
 * what 「停止」 stops, per agent. The unified semantic is "stop the
 * current turn and everything it started in the foreground" (Claude Code's
 * own interrupt): the turn, the subagents it runs, the commands it is
 * running. What the person backgrounded on purpose keeps running.
 *
 * `native`: the agent's own interrupt does it. `fallback`: the adapter does
 * it on top (Codex: `turn/interrupt` per subagent thread,
 * `thread/backgroundTerminals/terminate` per command). `none`: nothing to
 * stop (the agent has no such thing).
 *
 * Shaped as the `stop` part of the per-agent capabilities sketched in
 * research capability-matrix.md §2 (`agentFeatures[agent]`):
 * the Runner reports it as `agentFeatures[agent].stop` (and, for older
 * readers, as `agentStop`).
 *
 * | agent  | turn                 | subagents                        | commands                                      | survives                             |
 * | ------ | -------------------- | -------------------------------- | --------------------------------------------- | ------------------------------------ |
 * | claude | control `interrupt`  | native (foreground ones killed)  | native (foreground Bash killed)               | run_in_background Bash / Agent, Daisy background tasks  |
 * | codex  | root `turn/interrupt`| fallback: child `turn/interrupt` | fallback: terminate this turn's unified-exec  | earlier turns' terminals, Daisy background tasks  |
 * | kimi   | ACP `session/cancel` | none                             | native                                        | Daisy background tasks               |
 */
import { ACP_AGENTS, ACP_HARNESSES } from "./acp-harnesses.ts";

export type StopSupport = "native" | "fallback" | "none";
export type StopSurvivor =
  /** Daisy's background tasks and Claude's run_in_background. */
  | "backgroundTasks"
  /** Codex unified-exec processes an earlier turn left running. */
  | "earlierTurnCommands";
export interface AgentStopCapabilities {
  version: 1;
  /** The running turn's subagents stop with it. */
  subagents: StopSupport;
  /** The commands the running turn (and its subagents) run stop with it. */
  commands: StopSupport;
  /** What 「停止」 leaves running on purpose. */
  survives: StopSurvivor[];
  /**
   * Still not stopped after this: the Runner ends the agent's process
   * (the conversation resumes from its thread).
   */
  killAfterMs: number;
}
export const AGENT_STOP: Record<string, AgentStopCapabilities> = {
  claude: {
    version: 1,
    subagents: "native",
    commands: "native",
    survives: ["backgroundTasks"],
    killAfterMs: 5000,
  },
  codex: {
    version: 1,
    subagents: "fallback",
    commands: "fallback",
    survives: ["backgroundTasks", "earlierTurnCommands"],
    killAfterMs: 5000,
  },
  // P4-10: each ACP harness's own entry (acp-harnesses.ts).
  ...Object.fromEntries(
    ACP_AGENTS.map((a) => [a, { version: 1, ...ACP_HARNESSES[a]!.stop }]),
  ),
};
