#!/usr/bin/env node

/**
 * @module extensions/research/server
 * Standalone companion MCP server for AI Watch Research Suite.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { pool } from "../../../db/pool.js";
import { extension } from "./index.js";

async function main() {
  const server = new Server(
    { name: "krusch-research-mcp", version: "1.6.1" },
    { capabilities: { tools: {} } }
  );

  await extension.init(pool);

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: extension.tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const handler = extension.handlers.get(name);
    if (!handler) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
    return await handler(args || {});
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[krusch-research-mcp] Companion server running on stdio (${extension.tools.length} tools)`);
}

main().catch(err => {
  console.error("[krusch-research-mcp] Fatal error:", err);
  process.exit(1);
});
