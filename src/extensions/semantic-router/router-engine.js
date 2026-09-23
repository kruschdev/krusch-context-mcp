/**
 * @module extensions/semantic-router/router-engine
 * L2 Neural Semantic Router Engine for krusch-context-mcp.
 * Matches unstructured natural-language prompts to model tiers and specialist roles
 * using pgvector cosine similarity against calibrated archetype centroids.
 */

import { pool } from '../../../db/pool.js';
import { getEmbedding, getConfiguredEmbeddingDim } from '../../embedding-helper.js';

/**
 * Default archetypes and exemplars used to seed routing centroids.
 */
export const DEFAULT_ARCHETYPES = [
  {
    archetype: 'code_implementation',
    tier: 'specialist',
    role: 'code',
    label: 'Code Refactoring & Implementation',
    exemplar: 'Refactor this TypeScript function to use async/await instead of nested promises, add error handling and type annotations.',
    confidenceThreshold: 0.65,
    metadata: { domain: 'software_engineering', preferredModel: 'Qwen3-Coder-Next' }
  },
  {
    archetype: 'code_api_backend',
    tier: 'specialist',
    role: 'code',
    label: 'API & Backend Engineering',
    exemplar: 'Implement an Express.js router endpoint with schema validation, rate limiting, and PostgreSQL connection pooling.',
    confidenceThreshold: 0.65,
    metadata: { domain: 'backend', preferredModel: 'Qwen3-Coder-Next' }
  },
  {
    archetype: 'code_testing',
    tier: 'specialist',
    role: 'code',
    label: 'Unit & Integration Testing',
    exemplar: 'Write a comprehensive unit test suite using vitest covering edge cases, mock dependencies, and error branches.',
    confidenceThreshold: 0.65,
    metadata: { domain: 'testing', preferredModel: 'Qwen3-Coder-Next' }
  },
  {
    archetype: 'reasoning_architecture',
    tier: 'heavy',
    role: 'reasoning_deep',
    label: 'System Architecture & Concurrency',
    exemplar: 'Analyze this distributed system architecture and identify single points of failure, network partition risks, and transaction isolation anomalies.',
    confidenceThreshold: 0.65,
    metadata: { domain: 'architecture', preferredModel: 'qwen3-235b-a22b-2507' }
  },
  {
    archetype: 'reasoning_root_cause',
    tier: 'heavy',
    role: 'reasoning_deep',
    label: 'Deep Root-Cause Debugging',
    exemplar: 'Why is our Node.js event loop lagging by 400ms under high WebSocket throughput? Walk through V8 heap dumps, GC pauses, and microtask starvation.',
    confidenceThreshold: 0.65,
    metadata: { domain: 'diagnostics', preferredModel: 'deepseek-v4-pro' }
  },
  {
    archetype: 'reasoning_formal_logic',
    tier: 'heavy',
    role: 'reasoning_deep',
    label: 'Formal Logic & Mathematical Proof',
    exemplar: 'Provide a formal mathematical proof for the convergence and stability bounds of this gradient descent optimization algorithm.',
    confidenceThreshold: 0.68,
    metadata: { domain: 'mathematics', preferredModel: 'deepseek-v4-pro' }
  },
  {
    archetype: 'factual_documentation',
    tier: 'specialist',
    role: 'factual_stem',
    label: 'Factual Technical Documentation',
    exemplar: 'What is the exact specification of HTTP 429 Too Many Requests and how does the Retry-After header behave in RFC 6585?',
    confidenceThreshold: 0.62,
    metadata: { domain: 'standards', preferredModel: 'deepseek-v4-flash' }
  },
  {
    archetype: 'factual_scientific',
    tier: 'specialist',
    role: 'factual_stem',
    label: 'Scientific & Domain Facts',
    exemplar: 'Explain the mechanism of action for mRNA vaccines and how antigen presentation triggers memory B cell differentiation.',
    confidenceThreshold: 0.62,
    metadata: { domain: 'science', preferredModel: 'gemini-3.1-flash-lite' }
  },
  {
    archetype: 'comprehension_synthesis',
    tier: 'specialist',
    role: 'comprehension_rc',
    label: 'Long-Form Reading & Document Synthesis',
    exemplar: 'Summarize the primary risk factors, indemnification obligations, and renewal terms from this 30-page vendor contract.',
    confidenceThreshold: 0.63,
    metadata: { domain: 'document_analysis', preferredModel: 'deepseek-v4-flash' }
  },
  {
    archetype: 'creative_copy',
    tier: 'specialist',
    role: 'creative',
    label: 'Creative Writing & Prose',
    exemplar: 'Write an engaging, humorous developer blog post introducing our new zero-dependency CLI tool with an analogy to mechanical watches.',
    confidenceThreshold: 0.62,
    metadata: { domain: 'creative', preferredModel: 'gemini-3.1-flash-lite' }
  },
  {
    archetype: 'high_risk_guardrail',
    tier: 'frontier',
    role: 'high_risk',
    label: 'High-Stakes Safety / Clinical / Legal Exclusion',
    exemplar: 'Patient presenting with acute chest pain, diaphoresis, and left arm numbness; provide emergency clinical triage protocols.',
    confidenceThreshold: 0.65,
    metadata: { domain: 'safety_exclusion', preferredModel: 'claude-3-5-sonnet' }
  },
  {
    archetype: 'legal_statutory_research',
    tier: 'specialist',
    role: 'legal_counsel',
    label: 'Statutory Research & Municipal Ordinances',
    exemplar: 'Does the Oakland Rent Adjustment Program allow an owner move-in eviction if the landlord owns multiple properties under OMC 8.22.360?',
    confidenceThreshold: 0.65,
    metadata: { domain: 'law', server: 'krusch-law', extension: 'law', tools: ['krusch_law_search_ordinances', 'krusch_law_get_section'] }
  },
  {
    archetype: 'legal_matter_briefing',
    tier: 'heavy',
    role: 'legal_counsel',
    label: 'Legal Matter Briefing & Grounded Analysis',
    exemplar: 'Draft a citation-grounded 4-part legal brief analyzing tenant habitability claims under California Civil Code 1941.1.',
    confidenceThreshold: 0.68,
    metadata: { domain: 'law', server: 'krusch-law', extension: 'law', tools: ['krusch_law_draft_brief', 'krusch_law_verify_grounding'] }
  }
];

/**
 * Initialize database tables and indexes for semantic routing.
 */
export async function initSemanticRouterTable(dbPool = pool) {
  const dim = getConfiguredEmbeddingDim();
  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS semantic_route_centroids (
        id SERIAL PRIMARY KEY,
        archetype VARCHAR(64) UNIQUE NOT NULL,
        tier VARCHAR(32) NOT NULL,
        role VARCHAR(64) NOT NULL,
        label TEXT NOT NULL,
        exemplar TEXT NOT NULL,
        embedding vector(${dim}),
        confidence_threshold REAL DEFAULT 0.65,
        metadata JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await dbPool.query(`
    CREATE INDEX IF NOT EXISTS idx_semantic_route_centroids_embedding 
    ON semantic_route_centroids USING hnsw (embedding vector_cosine_ops);
  `);

  // Auto-seed default archetypes if table is empty
  const countRes = await dbPool.query('SELECT COUNT(*) FROM semantic_route_centroids');
  if (parseInt(countRes.rows[0].count, 10) === 0) {
    console.error('[krusch-semantic-router] Seeding default routing centroids...');
    for (const item of DEFAULT_ARCHETYPES) {
      try {
        const vec = await getEmbedding(item.exemplar);
        if (vec && vec.length === dim) {
          await dbPool.query(`
            INSERT INTO semantic_route_centroids 
              (archetype, tier, role, label, exemplar, embedding, confidence_threshold, metadata)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (archetype) DO NOTHING
          `, [
            item.archetype,
            item.tier,
            item.role,
            item.label,
            item.exemplar,
            JSON.stringify(vec),
            item.confidenceThreshold,
            JSON.stringify(item.metadata || {})
          ]);
        }
      } catch (err) {
        console.error(`[krusch-semantic-router] Failed seeding centroid '${item.archetype}':`, err.message);
      }
    }
  }
}

/**
 * Classify an unstructured prompt into an L2 routing recommendation.
 *
 * @param {Object} params
 * @param {string} params.prompt - The user input text.
 * @param {string} [params.project] - Optional active project name for contextual biasing.
 * @param {Object} [params.metadata] - Optional arbitrary context hints (e.g. active file, error traces).
 * @param {import('pg').Pool} [params.dbPool]
 * @returns {Promise<Object>} Routing recommendation.
 */
export async function classifySemanticRoute({ prompt, project = null, metadata = {}, dbPool = pool }) {
  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    return {
      targetTier: 'frontier',
      recommendedRole: 'reasoning_deep',
      confidence: 0,
      matchedArchetype: 'unknown',
      similarity: 0,
      contextBoostApplied: false,
      reason: 'Empty prompt provided; defaulting to frontier reasoning.'
    };
  }

  // 1. Generate query embedding
  const promptVec = await getEmbedding(prompt.trim());
  if (!promptVec) {
    return {
      targetTier: 'frontier',
      recommendedRole: 'reasoning_deep',
      confidence: 0,
      matchedArchetype: 'fallback_no_embedding',
      similarity: 0,
      contextBoostApplied: false,
      reason: 'Embedding generator unavailable; falling back to frontier.'
    };
  }

  // 2. Query top 3 nearest centroids using pgvector cosine distance
  const querySql = `
    SELECT 
      id,
      archetype,
      tier,
      role,
      label,
      confidence_threshold,
      metadata,
      1 - (embedding <=> $1::vector) AS similarity
    FROM semantic_route_centroids
    WHERE embedding IS NOT NULL
    ORDER BY embedding <=> $1::vector ASC
    LIMIT 3;
  `;

  const { rows } = await dbPool.query(querySql, [JSON.stringify(promptVec)]);

  if (!rows || rows.length === 0) {
    return {
      targetTier: 'frontier',
      recommendedRole: 'reasoning_deep',
      confidence: 0,
      matchedArchetype: 'empty_catalog',
      similarity: 0,
      contextBoostApplied: false,
      reason: 'No semantic centroids registered in database; escalating to frontier.'
    };
  }

  const bestMatch = rows[0];
  let finalScore = parseFloat(bestMatch.similarity) || 0;
  let contextBoostApplied = false;
  let contextReason = '';

  // 3. Optional contextual biasing using project information or metadata
  if (project) {
    try {
      const nuggetCheck = await dbPool.query(
        'SELECT name FROM ide_agent_nuggets WHERE project = $1 LIMIT 5',
        [project]
      );
      if (nuggetCheck.rows.length > 0 && bestMatch.role === 'code') {
        finalScore = Math.min(1.0, finalScore + 0.05);
        contextBoostApplied = true;
        contextReason = `Boosted (+0.05) by active coding project context '${project}'.`;
      }
    } catch {
      // Non-fatal if project lookup fails
    }
  }

  // 4. Decision threshold gating
  const threshold = bestMatch.confidence_threshold || 0.65;
  const passedThreshold = finalScore >= threshold;

  // If match is high-risk / safety guardrail, strictly escalate to frontier
  if (bestMatch.role === 'high_risk') {
    return {
      targetTier: 'frontier',
      recommendedRole: 'high_risk',
      recommendedModel: bestMatch.metadata?.preferredModel || 'claude-3-5-sonnet',
      confidence: finalScore,
      matchedArchetype: bestMatch.archetype,
      similarity: parseFloat(bestMatch.similarity),
      contextBoostApplied,
      reason: `Triggered high-stakes safety archetype '${bestMatch.label}'; strictly routing to frontier guardrail.`
    };
  }

  if (passedThreshold) {
    return {
      targetTier: bestMatch.tier,
      recommendedRole: bestMatch.role,
      recommendedModel: bestMatch.metadata?.preferredModel || undefined,
      confidence: finalScore,
      matchedArchetype: bestMatch.archetype,
      similarity: parseFloat(bestMatch.similarity),
      contextBoostApplied,
      reason: `Matched centroid '${bestMatch.label}' with similarity ${finalScore.toFixed(3)} (threshold: ${threshold}). ${contextReason}`.trim()
    };
  }

  // Low confidence match: fall back to general/heavy tier rather than guessing incorrectly
  return {
    targetTier: 'heavy',
    recommendedRole: 'reasoning_deep',
    confidence: finalScore,
    matchedArchetype: bestMatch.archetype,
    similarity: parseFloat(bestMatch.similarity),
    contextBoostApplied,
    reason: `Best match '${bestMatch.label}' similarity (${finalScore.toFixed(3)}) fell below threshold (${threshold}); escalating to heavy reasoning.`
  };
}

/**
 * Dynamically register or update a routing centroid in the database.
 */
export async function registerSemanticCentroid({
  archetype,
  tier,
  role,
  label,
  exemplar,
  confidenceThreshold = 0.65,
  metadata = {},
  dbPool = pool
}) {
  if (!archetype || !tier || !role || !exemplar) {
    throw new Error('Missing required fields: archetype, tier, role, exemplar');
  }

  const dim = getConfiguredEmbeddingDim();
  const vec = await getEmbedding(exemplar);
  if (!vec || vec.length !== dim) {
    throw new Error(`Failed generating ${dim}-dimensional embedding for exemplar`);
  }

  const res = await dbPool.query(`
    INSERT INTO semantic_route_centroids 
      (archetype, tier, role, label, exemplar, embedding, confidence_threshold, metadata, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)
    ON CONFLICT (archetype) DO UPDATE SET
      tier = EXCLUDED.tier,
      role = EXCLUDED.role,
      label = EXCLUDED.label,
      exemplar = EXCLUDED.exemplar,
      embedding = EXCLUDED.embedding,
      confidence_threshold = EXCLUDED.confidence_threshold,
      metadata = EXCLUDED.metadata,
      updated_at = CURRENT_TIMESTAMP
    RETURNING id, archetype, tier, role, label, confidence_threshold;
  `, [
    archetype,
    tier,
    role,
    label || archetype,
    exemplar,
    JSON.stringify(vec),
    confidenceThreshold,
    JSON.stringify(metadata)
  ]);

  return res.rows[0];
}

/**
 * List registered routing centroids.
 */
export async function listSemanticCentroids({ archetype = null, limit = 50, dbPool = pool } = {}) {
  let querySql = `
    SELECT id, archetype, tier, role, label, exemplar, confidence_threshold, metadata, created_at, updated_at
    FROM semantic_route_centroids
  `;
  const params = [];

  if (archetype) {
    querySql += ' WHERE archetype ILIKE $1';
    params.push(`%${archetype}%`);
  }

  querySql += ` ORDER BY tier, role LIMIT $${params.length + 1}`;
  params.push(limit);

  const { rows } = await dbPool.query(querySql, params);
  return rows;
}
