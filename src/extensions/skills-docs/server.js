#!/usr/bin/env node

/**
 * @module extensions/skills-docs/server
 * Standalone companion MCP server for Agent Skills & Documentation.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { extension } from "./index.js";

async function main() {
  const server = new Server(
    { name: "krusch-skills-docs-mcp", version: "1.5.0" },
    { capabilities: { tools: {} } }
  );

  await extension.init();

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
  console.error(`[krusch-skills-docs-mcp] Companion server running on stdio (${extension.tools.length} tools)`);
}

main().catch(err => {
  console.error("[krusch-skills-docs-mcp] Fatal error:", err);
  process.exit(1);
});
