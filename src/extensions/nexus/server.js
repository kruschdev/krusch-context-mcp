#!/usr/bin/env node

/**
 * @module extensions/nexus/server
 * Standalone companion MCP server for KruschNexus Universal Document Ingestion & Citation Spine.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { extension } from "./index.js";

async function main() {
  const server = new Server(
    { name: "krusch-nexus-companion-mcp", version: "1.0.0" },
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
  console.error(`[krusch-nexus-companion-mcp] Companion server running on stdio (${extension.tools.length} tools)`);
}

main().catch(err => {
  console.error("[krusch-nexus-companion-mcp] Fatal error:", err);
  process.exit(1);
});
