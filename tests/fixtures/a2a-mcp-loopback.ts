/**
 * P4-09 tests only: the standalone A2A MCP's `main` with the outbound rules
 * relaxed for loopback (ADR-127 §4: a test Daisy listens on 127.0.0.1) and,
 * when A2A_MCP_TEST_LIMITS is set (JSON), shorter waits. The real entry
 * (packages/a2a-mcp/src/bin.ts, the bundle) has no way to do either.
 */
import { main } from "../../packages/a2a-mcp/src/main.ts";

const limits = process.env.A2A_MCP_TEST_LIMITS ? JSON.parse(process.env.A2A_MCP_TEST_LIMITS) : {};
process.exitCode = await main(process.argv.slice(2), { policy: { allowLoopback: true }, limits });
