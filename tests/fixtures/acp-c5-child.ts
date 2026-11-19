/**
 * P4-10 / C-5: a Daisy process whose only knowledge of a new ACP harness is
 * one entry in `$DAISY_ACP_HARNESSES` (set by the parent test before this
 * process loads anything). Runs C-2's required capabilities against it and
 * prints the result as one JSON line.
 *
 *   node --import tsx tests/fixtures/acp-c5-child.ts <dir> <agent>
 */
import { AgentSchema } from "../../packages/contracts/src/session.ts";
import { AGENT_CAPABILITIES } from "../../packages/contracts/src/agent-capabilities.ts";
import { capabilities } from "../../packages/daisy/src/turns/worker.ts";
import { runC2 } from "./acp-scenario.ts";

const [dir, agent] = process.argv.slice(2) as [string, string];
try {
  AgentSchema.parse(agent);
  const caps = await capabilities();
  const result = await runC2(agent, dir, "session/load");
  process.stdout.write(
    JSON.stringify({
      ok: true,
      result,
      declared: AGENT_CAPABILITIES[agent],
      detected: caps[agent],
      reported: caps.agentFeatures?.[agent]?.agent,
    }) + "\n",
  );
  process.exit(0);
} catch (e: any) {
  process.stdout.write(
    JSON.stringify({ ok: false, error: String(e?.stack || e) }) + "\n",
  );
  process.exit(1);
}
