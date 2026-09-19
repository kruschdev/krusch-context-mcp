/**
 * @module extensions/semantic-router
 * Neural Semantic Router Extension for krusch-context-mcp.
 * Provides L2 vector-based classification of unstructured prompts to domain specialists.
 */

import {
  initSemanticRouterTable,
  classifySemanticRoute,
  registerSemanticCentroid,
  listSemanticCentroids
} from './router-engine.js';

export const tools = [
  {
    name: "krusch_context_semantic_route",
    description: "Neural Semantic Router (L2): Classify an unstructured natural-language prompt into an optimal model tier and specialist role using pgvector cosine distance against calibrated archetype centroids.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "The incoming user prompt or task description to classify."
        },
        project: {
          type: "string",
          description: "Optional project scope to bias model selection based on active workspace stack."
        },
        metadata: {
          type: "object",
          description: "Optional contextual hints such as active file path or diagnostic logs."
        }
      },
      required: ["prompt"]
    }
  },
  {
    name: "krusch_context_register_semantic_centroid",
    description: "Register or update a semantic routing centroid exemplar in the pgvector database.",
    inputSchema: {
      type: "object",
      properties: {
        archetype: {
          type: "string",
          description: "Unique slug for the routing archetype (e.g. 'code_refactoring', 'deep_diagnostics')."
        },
        tier: {
          type: "string",
          enum: ["specialist", "heavy", "frontier"],
          description: "Target model tier."
        },
        role: {
          type: "string",
          enum: ["code", "reasoning_deep", "reasoning_fast", "factual_stem", "comprehension_rc", "creative", "high_risk"],
          description: "Domain specialist role."
        },
        label: {
          type: "string",
          description: "Human-readable label."
        },
        exemplar: {
          type: "string",
          description: "Representative prompt or phrasing whose vector embedding serves as the centroid anchor."
        },
        confidence_threshold: {
          type: "number",
          description: "Minimum cosine similarity threshold (e.g. 0.65)."
        },
        metadata: {
          type: "object",
          description: "Optional metadata (preferred model, domain tags, etc.)."
        }
      },
      required: ["archetype", "tier", "role", "label", "exemplar"]
    }
  },
  {
    name: "krusch_context_list_semantic_centroids",
    description: "List registered routing archetypes, tiers, and exemplar anchors.",
    inputSchema: {
      type: "object",
      properties: {
        archetype: {
          type: "string",
          description: "Optional filter by archetype name substring."
        },
        limit: {
          type: "number",
          description: "Maximum centroids to return (default: 50)."
        }
      }
    }
  }
];

export const handlers = new Map([
  ['krusch_context_semantic_route', async (args) => {
    const result = await classifySemanticRoute(args);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2)
        }
      ]
    };
  }],
  ['krusch_context_register_semantic_centroid', async (args) => {
    const record = await registerSemanticCentroid({
      archetype: args.archetype,
      tier: args.tier,
      role: args.role,
      label: args.label,
      exemplar: args.exemplar,
      confidenceThreshold: args.confidence_threshold,
      metadata: args.metadata
    });
    return {
      content: [
        {
          type: "text",
          text: `Registered centroid '${record.archetype}' [${record.tier}/${record.role}] successfully.`
        }
      ]
    };
  }],
  ['krusch_context_list_semantic_centroids', async (args) => {
    const centroids = await listSemanticCentroids(args || {});
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(centroids, null, 2)
        }
      ]
    };
  }]
]);

export const extension = {
  name: "semantic-router",
  description: "L2 Neural Semantic Router — pgvector centroid classification for unstructured and conversational prompts.",
  init: initSemanticRouterTable,
  tools,
  handlers
};

export default extension;
