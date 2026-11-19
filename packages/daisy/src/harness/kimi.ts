/**
 * Kimi Code CLI (`kimi acp`): since P4-10 one entry of the ACP harness table
 * (contracts acp-harnesses.ts) driven by the generic ACP adapter (acp.ts).
 * These names stay for the callers and tests that used them.
 */
import { AGENT_CAPABILITIES } from "../../../contracts/src/agent-capabilities.ts";
import { acpAgentFor } from "./acp.ts";
import { oneShot, type Runtime } from "./shared.ts";
/** the unified semantics this adapter does natively (reported). */
export const KIMI_CAPABILITIES = AGENT_CAPABILITIES.kimi!;
/** Kimi ACP, one process per session. */
export const kimiAgent = acpAgentFor("kimi");
/** One Kimi turn in a process that ends with it (offline mode, tests). */
export const runKimi = (rt: Runtime) => oneShot(kimiAgent, rt);
