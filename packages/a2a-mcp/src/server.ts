/**
 * P4-09 (ADR-128 §5): the MCP server — the official SDK
 * (`@modelcontextprotocol/sdk`) over stdio, three tools, the same names and
 * arguments as P4-08's in Daisy (ADR-127 §2): `agents`, `call_agent`,
 * `call_result`. Client only: it opens no port and has no address; it only
 * ever connects out (5.2: 「别人没有地址可以调用它」).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { MCP_COMMAND_NAME, MCP_NAME } from "../../contracts/src/names.ts";
import { agentsArgs, callArgs, resultArgs, ToolError, type McpClient } from "./calls.ts";
import { pt } from "../../contracts/src/i18n-process.ts";
import { VERSION } from "./version.ts";

/* P6-23b: what the model reads (instructions, tool titles and descriptions) is in this process's language. */

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (e: unknown): ToolResult => ({
  content: [{ type: "text", text: e instanceof ToolError ? e.message : pt("mcp.tool.failed", { why: String((e as Error)?.message ?? e).slice(0, 300) }) }],
  isError: true,
});

export function mcpServer(client: McpClient): McpServer {
  const server = new McpServer(
    { name: MCP_COMMAND_NAME, title: MCP_NAME, version: VERSION },
    { instructions: pt("mcp.instructions", { name: MCP_NAME, cmd: MCP_COMMAND_NAME }) },
  );
  server.registerTool(
    "agents",
    {
      title: pt("mcp.tool.agents.title"),
      description: pt("mcp.tool.agents.description"),
      inputSchema: agentsArgs(),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (a) => {
      try {
        return ok(await client.agents(a));
      } catch (e) {
        return fail(e);
      }
    },
  );
  server.registerTool(
    "call_agent",
    {
      title: pt("mcp.tool.call.title"),
      description: pt("mcp.tool.call.description"),
      inputSchema: callArgs(),
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (a) => {
      try {
        const r = await client.call(a);
        return { ...ok(r.text), ...(r.ok ? {} : { isError: true }) };
      } catch (e) {
        return fail(e);
      }
    },
  );
  server.registerTool(
    "call_result",
    {
      title: pt("mcp.tool.result.title"),
      description: pt("mcp.tool.result.description"),
      inputSchema: resultArgs(),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (a) => {
      try {
        return ok(await client.result(a));
      } catch (e) {
        return fail(e);
      }
    },
  );
  return server;
}

/** Serve on `transport` until it closes. */
export async function serve(client: McpClient, transport: Transport): Promise<void> {
  const server = mcpServer(client);
  const closed = new Promise<void>((resolve) => {
    server.server.onclose = () => resolve();
  });
  await server.connect(transport);
  await closed;
}
