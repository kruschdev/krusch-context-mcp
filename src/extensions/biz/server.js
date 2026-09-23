#!/usr/bin/env node

/**
 * @module extensions/biz/server
 * Standalone companion MCP server for KruschBiz Sovereign Corporate Intelligence.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { extension } from "./index.js";

async function main() {
  const server = new Server(
    { name: "krusch-biz-companion-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

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
  console.error(`[krusch-biz-companion-mcp] Companion server running on stdio (${extension.tools.length} tools)`);
}

main().catch(err => {
  console.error("[krusch-biz-companion-mcp] Fatal error:", err);
  process.exit(1);
});
