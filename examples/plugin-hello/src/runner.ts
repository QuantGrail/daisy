/**
 * The Runner half: `sessionEnv` adds variables to every
 * harness process of a session (Claude Code, Codex, an ACP harness …).
 * `envKeys` lists them, so Daisy removes them where a process is not the
 * session's own work (title generation, the owner's `!` shell).
 */
import type { DaisyRunnerPlugin, RunnerPluginHost } from "@daisy-ai/daisy/plugin";

export const ENV_KEYS = ["HELLO_SESSION", "HELLO_AGENT", "HELLO_GREETING"] as const;

export function createRunnerPlugin(host: RunnerPluginHost): DaisyRunnerPlugin {
  const greeting = typeof host.options.greeting === "string" ? host.options.greeting.slice(0, 200) : "hello from Daisy";
  return {
    name: "example-hello",
    envKeys: ENV_KEYS,
    sessionEnv: (s) => ({
      HELLO_SESSION: s.id,
      HELLO_AGENT: s.agent,
      HELLO_GREETING: greeting,
    }),
  };
}
