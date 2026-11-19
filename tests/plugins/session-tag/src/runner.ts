/**
 * Test-only plugin (P4-13): hook 1's `sessionEnv` — every harness process
 * of a session carries its id, agent and an attribution flag, the way an
 * integration plugin tags its own; the core's tests find processes and
 * spawn records by them with no other plugin installed.
 */
import type { DaisyRunnerPlugin } from "@daisy-ai/daisy/plugin";

export const ENV_KEYS = ["DAISY_TEST_SESSION", "DAISY_TEST_AGENT", "DAISY_TEST_VIA"] as const;

export function createRunnerPlugin(): DaisyRunnerPlugin {
  return {
    name: "session-tag",
    envKeys: ENV_KEYS,
    sessionEnv: (s) => ({
      DAISY_TEST_SESSION: s.id,
      DAISY_TEST_AGENT: s.agent,
      DAISY_TEST_VIA: "ai",
    }),
  };
}
