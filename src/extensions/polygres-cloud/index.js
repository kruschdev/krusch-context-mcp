/**
 * @module extensions/polygres-cloud
 * Polygres Cloud Runtime 0.5.0 Extension for krusch-context-mcp.
 */

import {
  getCloudUsage,
  getCloudEmbeddingModels,
  getCloudCapabilities,
  listCloudEmbeddingConfigs,
  searchCloudContext
} from './polygres-cloud.js';

export const tools = [
  {
    name: "polygres_cloud_usage",
    description: "Polygres Cloud v0.5.0 Quota Monitor: Fetch live microcredit allowance, generation/query usage, and remaining free quota for the active Polygres project.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "polygres_cloud_search",
    description: "Polygres Cloud v0.5.0 In-Engine Search: Perform semantic or hybrid search over a cloud pgContext collection using pure text input (embeddings generated in-engine with zero local model load).",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Target pgContext collection name" },
        text: { type: "string", description: "Raw text query to search and embed in-engine" },
        limit: { type: "number", default: 10, description: "Max results to return (default 10)" },
        filters: { type: "object", description: "Optional metadata filters" }
      },
      required: ["text"]
    }
  },
  {
    name: "polygres_cloud_models",
    description: "Polygres Cloud v0.5.0 Model Catalog: Discover available in-engine embedding models, dimensions, and microcredit pricing.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "polygres_cloud_capabilities",
    description: "Polygres Cloud v0.5.0 Engine Capabilities: Inspect server-side pgContext version, HNSW limits (max record bytes, M factor), and compatibility.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "polygres_cloud_embedding_configs",
    description: "Polygres Cloud v0.5.0 Watched Tables: List automated in-database embedding pipelines configured on database tables.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  }
];

export const handlers = new Map([
  ['polygres_cloud_usage', async () => {
    const usage = await getCloudUsage();
    return { content: [{ type: "text", text: usage.summaryText }] };
  }],
  ['polygres_cloud_search', async (args) => {
    const results = await searchCloudContext(args);
    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  }],
  ['polygres_cloud_models', async () => {
    const models = await getCloudEmbeddingModels();
    return { content: [{ type: "text", text: JSON.stringify(models, null, 2) }] };
  }],
  ['polygres_cloud_capabilities', async () => {
    const caps = await getCloudCapabilities();
    return { content: [{ type: "text", text: JSON.stringify(caps, null, 2) }] };
  }],
  ['polygres_cloud_embedding_configs', async () => {
    const configs = await listCloudEmbeddingConfigs();
    return { content: [{ type: "text", text: JSON.stringify(configs, null, 2) }] };
  }]
]);

export const extension = {
  name: "polygres-cloud",
  description: "Polygres Cloud Runtime 0.5.0 Integration — in-engine embeddings, cloud collection search, and quota monitoring.",
  init: null, // Remote API, no local DB tables needed
  tools,
  handlers
};

export default extension;
