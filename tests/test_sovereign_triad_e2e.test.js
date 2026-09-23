import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../db/pool.js';
import { getAvailableExtensionNames, resolveExtension, loadExtensions } from '../src/extensions/index.js';
import { getActiveProfile, getRequestedExtensions } from '../src/index.js';
import { 
  COMMERCIAL_PATTERN, 
  CITATION_PATTERN, 
  STATUTORY_PATTERN,
  handleProactiveNudge 
} from '../src/proactive-engine.js';
import { classifySemanticRoute } from '../src/extensions/semantic-router/router-engine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('Sovereign Triad End-to-End Integration Suite', async (t) => {

  await t.test('1. Profile resolution bundles Sovereign Quartet', () => {
    const originalProfile = process.env.KRUSCH_PROFILE;
    try {
      process.env.KRUSCH_PROFILE = 'sovereign';
      assert.strictEqual(getActiveProfile(), 'sovereign');
      const sovereignExts = getRequestedExtensions();
      assert.ok(sovereignExts.includes('nexus'), 'Sovereign profile must include nexus');
      assert.ok(sovereignExts.includes('biz'), 'Sovereign profile must include biz');
      assert.ok(sovereignExts.includes('law'), 'Sovereign profile must include law');
      assert.ok(sovereignExts.includes('semantic-router'), 'Sovereign profile must include semantic-router');

      process.env.KRUSCH_PROFILE = 'ecosystem';
      assert.strictEqual(getActiveProfile(), 'ecosystem');
      const ecosystemExts = getRequestedExtensions();
      assert.ok(ecosystemExts.includes('nexus'));
      assert.ok(ecosystemExts.includes('biz'));
      assert.ok(ecosystemExts.includes('law'));
      assert.ok(ecosystemExts.includes('semantic-router'));
    } finally {
      process.env.KRUSCH_PROFILE = originalProfile;
    }
  });

  await t.test('2. Dynamic extension loading for Sovereign Quartet', async () => {
    const loaded = await loadExtensions(['nexus', 'biz', 'law', 'semantic-router']);
    assert.strictEqual(loaded.length, 4, 'Should load exactly 4 extensions');

    const allTools = loaded.flatMap(e => e.tools);
    const allHandlers = new Map(loaded.flatMap(e => Array.from(e.handlers.entries())));
    const toolNames = allTools.map(t => t.name);

    // Nexus (6 tools)
    assert.ok(toolNames.includes('krusch_nexus_list_workspaces'));
    assert.ok(toolNames.includes('krusch_nexus_list_documents'));
    assert.ok(toolNames.includes('krusch_nexus_search_corpus'));
    assert.ok(toolNames.includes('krusch_nexus_get_ingest_report'));
    assert.ok(toolNames.includes('krusch_nexus_ingest_file'));
    assert.ok(toolNames.includes('krusch_nexus_verify_span'));

    // Biz (7 tools)
    assert.ok(toolNames.includes('krusch_biz_search_contracts'));
    assert.ok(toolNames.includes('krusch_biz_get_clause'));
    assert.ok(toolNames.includes('krusch_biz_resolve_controlling_clause'));
    assert.ok(toolNames.includes('krusch_biz_detect_conflicts'));
    assert.ok(toolNames.includes('krusch_biz_diff_instruments'));
    assert.ok(toolNames.includes('krusch_biz_draft_deal_brief'));
    assert.ok(toolNames.includes('krusch_biz_list_deals'));

    // Law (8 tools)
    assert.ok(toolNames.includes('krusch_law_search_ordinances'));
    assert.ok(toolNames.includes('krusch_law_get_section'));
    assert.ok(toolNames.includes('krusch_law_draft_brief'));
    assert.ok(toolNames.includes('krusch_law_verify_grounding'));
    assert.ok(toolNames.includes('krusch_law_flag_stale_memories'));
    assert.ok(toolNames.includes('krusch_law_review_stale_queue'));
    assert.ok(toolNames.includes('krusch_law_resolve_stale_memory'));
    assert.ok(toolNames.includes('krusch_law_get_traceability'));

    // Semantic Router (3 tools)
    assert.ok(toolNames.includes('krusch_context_semantic_route'));
    assert.ok(toolNames.includes('krusch_context_register_semantic_centroid'));
    assert.ok(toolNames.includes('krusch_context_list_semantic_centroids'));

    // Total = 6 + 7 + 8 + 3 = 24 sovereign tools
    assert.strictEqual(allTools.length, 24, `Expected 24 tools, got ${allTools.length}`);

    // Verify all tools have matching handlers
    for (const tool of allTools) {
      assert.ok(allHandlers.has(tool.name), `Missing handler for ${tool.name}`);
    }
  });

  await t.test('3. Proactive Guardrails detect ungrounded contracts, statutes, and citations', async () => {
    // Commercial regex trigger
    const commercialQuery = 'We need to amend Section 4 of the Master Services Agreement to increase liability cap';
    assert.ok(COMMERCIAL_PATTERN.test(commercialQuery), 'COMMERCIAL_PATTERN should match MSA query');

    // Citation regex trigger
    const citationQuery = 'According to page 42 of the document, the indemnity is capped at $500,000';
    assert.ok(CITATION_PATTERN.test(citationQuery), 'CITATION_PATTERN should match page reference query');

    // Statutory regex trigger
    const statutoryQuery = 'Compliance with Section 8.22.030 rent adjustment limitations';
    assert.ok(STATUTORY_PATTERN.test(statutoryQuery), 'STATUTORY_PATTERN should match Section statutory query');

    // Proactive nudge handler invocation test (non-crashing contract)
    const nudgeRes = await handleProactiveNudge({
      history: [{ role: 'user', content: 'Review the general repo structure' }]
    });
    assert.ok(nudgeRes && Array.isArray(nudgeRes.content), 'handleProactiveNudge must return MCP content array');
  });

  await t.test('4. Semantic routing to Sovereign centroids', async () => {
    // Route document ingestion query
    const ingestRoute = await classifySemanticRoute({
      prompt: 'Batch ingest PDF agreements and extract OCR layouts with character offsets',
      dbPool: pool
    });
    assert.ok(ingestRoute, 'Should classify routing');
    assert.ok(ingestRoute.matchedArchetype, 'Should identify matched archetype');
    assert.ok(ingestRoute.recommendedRole, 'Should identify recommended role');

    // Route contract resolution query
    const contractRoute = await classifySemanticRoute({
      prompt: 'Check which amendment controls the indemnification provision in this corporate buyout',
      dbPool: pool
    });
    assert.ok(contractRoute, 'Should classify routing');
    assert.ok(contractRoute.matchedArchetype, 'Should identify matched archetype');
    assert.ok(contractRoute.recommendedRole, 'Should identify recommended role');
  });

  await t.test('5. Graceful offline degradation for all companion engines', async () => {
    const loaded = await loadExtensions(['nexus', 'biz', 'law']);
    const allHandlers = new Map(loaded.flatMap(e => Array.from(e.handlers.entries())));
    
    // Set unreachable ports
    const oldNexus = process.env.NEXUS_API_URL;
    const oldBiz = process.env.KRUSCHBIZ_API_URL;
    const oldLaw = process.env.KRUSCHLAW_API_URL;

    process.env.NEXUS_API_URL = 'http://127.0.0.1:59991';
    process.env.KRUSCHBIZ_API_URL = 'http://127.0.0.1:59992';
    process.env.KRUSCHLAW_API_URL = 'http://127.0.0.1:59993';

    try {
      // Nexus verify_span handler
      const nexusHandler = allHandlers.get('krusch_nexus_verify_span');
      const nexusRes = await nexusHandler({ document_id: 'doc-1', char_start: 0, char_end: 10, quote: 'test' });
      assert.ok(nexusRes.isError || nexusRes.content[0].text.includes('unavailable') || nexusRes.content[0].text.includes('Offline'));

      // Biz resolve_controlling_clause handler
      const bizHandler = allHandlers.get('krusch_biz_resolve_controlling_clause');
      const bizRes = await bizHandler({ clause_type: 'INDEMNIFICATION' });
      assert.ok(bizRes.isError || bizRes.content[0].text.includes('unavailable') || bizRes.content[0].text.includes('Offline'));

      // Law get_traceability handler
      const lawHandler = allHandlers.get('krusch_law_get_traceability');
      const lawRes = await lawHandler({});
      assert.ok(lawRes.isError || lawRes.content[0].text.includes('unavailable') || lawRes.content[0].text.includes('Offline'));
    } finally {
      process.env.NEXUS_API_URL = oldNexus;
      process.env.KRUSCHBIZ_API_URL = oldBiz;
      process.env.KRUSCHLAW_API_URL = oldLaw;
    }
  });

  t.after(async () => {
    await pool.end();
  });
});
