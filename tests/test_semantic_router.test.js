import test from 'node:test';
import assert from 'node:assert';
import { pool } from '../db/pool.js';
import {
  initSemanticRouterTable,
  classifySemanticRoute,
  registerSemanticCentroid,
  listSemanticCentroids
} from '../src/extensions/semantic-router/router-engine.js';
import semanticRouterExtension from '../src/extensions/semantic-router/index.js';

test('L2 Neural Semantic Router Extension Tests', async (t) => {
  // 1. Table & Seed Initialization
  await t.test('initSemanticRouterTable initializes table and seeds default archetypes', async () => {
    await initSemanticRouterTable(pool);
    const centroids = await listSemanticCentroids({ dbPool: pool });
    assert.ok(centroids.length >= 5, `Expected at least 5 centroids, got ${centroids.length}`);
    
    const archetypes = centroids.map(c => c.archetype);
    assert.ok(archetypes.includes('code_implementation'), 'Should include code_implementation');
    assert.ok(archetypes.includes('reasoning_architecture'), 'Should include reasoning_architecture');
    assert.ok(archetypes.includes('high_risk_guardrail'), 'Should include high_risk_guardrail');
  });

  // 2. Classify Code Implementation Query
  await t.test('classifySemanticRoute routes coding prompts to code specialist role', async () => {
    const res = await classifySemanticRoute({
      prompt: 'Refactor this TypeScript express middleware to validate authorization bearer tokens.',
      dbPool: pool
    });

    assert.ok(res.confidence > 0.5, `Confidence ${res.confidence} should be > 0.5`);
    assert.strictEqual(res.recommendedRole, 'code', 'Should route to code specialist');
    assert.strictEqual(res.targetTier, 'specialist', 'Should target specialist tier');
  });

  // 3. Classify Deep Reasoning Query
  await t.test('classifySemanticRoute routes system architecture and root-cause queries to reasoning_deep', async () => {
    const res = await classifySemanticRoute({
      prompt: 'Analyze distributed database deadlock and transaction isolation anomaly during concurrent checkout operations.',
      dbPool: pool
    });

    assert.ok(res.confidence > 0.5, `Confidence ${res.confidence} should be > 0.5`);
    assert.strictEqual(res.recommendedRole, 'reasoning_deep', 'Should route to reasoning_deep');
    assert.strictEqual(res.targetTier, 'heavy', 'Should target heavy tier');
  });

  // 4. Classify High-Stakes Guardrail Query
  await t.test('classifySemanticRoute escalates high-risk queries directly to frontier', async () => {
    const res = await classifySemanticRoute({
      prompt: 'Patient presenting with severe acute myocardial infarction and chest pain in emergency department.',
      dbPool: pool
    });

    assert.strictEqual(res.recommendedRole, 'high_risk', 'Should identify high_risk guardrail');
    assert.strictEqual(res.targetTier, 'frontier', 'Should escalate to frontier tier');
    assert.ok(res.reason.includes('safety archetype'), 'Reason should explain safety escalation');
  });

  // 5. Dynamic Centroid Registration
  await t.test('registerSemanticCentroid allows registering custom domain archetype', async () => {
    const newCentroid = await registerSemanticCentroid({
      archetype: 'unit_test_custom_devops',
      tier: 'specialist',
      role: 'factual_stem',
      label: 'Kubernetes Helm Deployment',
      exemplar: 'Configure Kubernetes ingress controller with TLS certificate manager and Helm chart values.',
      confidenceThreshold: 0.60,
      metadata: { domain: 'devops' },
      dbPool: pool
    });

    assert.strictEqual(newCentroid.archetype, 'unit_test_custom_devops');

    // Verify it appears in listing
    const match = await listSemanticCentroids({ archetype: 'unit_test_custom_devops', dbPool: pool });
    assert.strictEqual(match.length, 1);
    assert.strictEqual(match[0].label, 'Kubernetes Helm Deployment');
  });

  // 6. Test Extension MCP Handlers
  await t.test('MCP tool handler krusch_context_semantic_route executes cleanly', async () => {
    const handler = semanticRouterExtension.handlers.get('krusch_context_semantic_route');
    assert.ok(handler, 'Handler should be defined');

    const result = await handler({
      prompt: 'How do I optimize postgres connection pool settings for high concurrency?'
    });

    assert.ok(result.content && result.content[0].text);
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(parsed.recommendedRole, 'Parsed output should contain recommendedRole');
    assert.ok(parsed.confidence !== undefined, 'Parsed output should contain confidence');
  });

  // 7. Test Sovereign Triad Archetype Seeding
  await t.test('seeds Sovereign Triad archetypes for Law, Nexus, and Biz', async () => {
    const centroids = await listSemanticCentroids({ dbPool: pool });
    const archetypes = centroids.map(c => c.archetype);

    assert.ok(archetypes.includes('legal_statutory_research'), 'Should include legal_statutory_research');
    assert.ok(archetypes.includes('nexus_document_ingestion'), 'Should include nexus_document_ingestion');
    assert.ok(archetypes.includes('biz_contract_analysis'), 'Should include biz_contract_analysis');
  });


  t.after(async () => {
    // Cleanup temporary unit test centroid
    await pool.query("DELETE FROM semantic_route_centroids WHERE archetype = 'unit_test_custom_devops'");
    await pool.end();
  });
});
