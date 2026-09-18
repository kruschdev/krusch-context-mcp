#!/usr/bin/env node

/**
 * @module extensions/company-brain/server
 * Standalone companion MCP server for Company Brain v2 Substrate.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { pool } from "../../../db/pool.js";
import { extension } from "./index.js";

async function main() {
  const server = new Server(
    { name: "krusch-company-brain-mcp", version: "1.6.2" },
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
  console.error(`[krusch-company-brain-mcp] Companion server running on stdio (${extension.tools.length} tools)`);
}

main().catch(err => {
  console.error("[krusch-company-brain-mcp] Fatal error:", err);
  process.exit(1);
});
