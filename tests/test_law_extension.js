/**
 * Test suite for KruschLaw companion extension in krusch-context-mcp.
 * Validates extension registration, tool schemas, handler bindings,
 * and graceful degradation behavior.
 */

import assert from 'node:assert';
import { getAvailableExtensionNames, resolveExtension, loadExtensions } from '../src/extensions/index.js';
import { tools, handlers, extension } from '../src/extensions/law/index.js';
import {
  searchOrdinances,
  getSection,
  draftGroundedBrief,
  verifyAssertionGrounding,
  flagStaleMemories,
  reviewStaleQueue,
  resolveStaleMemory
} from '../src/extensions/law/law-engine.js';

async function runTests() {
  console.log('🧪 Starting KruschLaw Extension Tests...');

  // 1. Registry verification
  console.log('  1. Checking extension registration...');
  const available = getAvailableExtensionNames();
  assert.ok(available.includes('law'), 'Extension "law" should be listed in available extensions');
  
  const resolvedDirect = resolveExtension('law');
  assert.ok(resolvedDirect, 'resolveExtension("law") must return extension object');
  assert.strictEqual(resolvedDirect.name, 'law');

  const resolvedAlias = resolveExtension('krusch-law');
  assert.ok(resolvedAlias, 'resolveExtension("krusch-law") alias must return extension object');

  const resolvedLegal = resolveExtension('legal');
  assert.ok(resolvedLegal, 'resolveExtension("legal") alias must return extension object');

  // 2. Tool structure and schemas
  console.log('  2. Validating tool definitions...');
  assert.strictEqual(tools.length, 8, 'Should expose exactly 8 legal tools');
  
  const toolNames = tools.map(t => t.name);
  assert.ok(toolNames.includes('krusch_law_search_ordinances'));
  assert.ok(toolNames.includes('krusch_law_get_section'));
  assert.ok(toolNames.includes('krusch_law_draft_brief'));
  assert.ok(toolNames.includes('krusch_law_verify_grounding'));
  assert.ok(toolNames.includes('krusch_law_flag_stale_memories'));
  assert.ok(toolNames.includes('krusch_law_review_stale_queue'));
  assert.ok(toolNames.includes('krusch_law_resolve_stale_memory'));
  assert.ok(toolNames.includes('krusch_law_get_traceability'));


  for (const tool of tools) {
    assert.ok(tool.name, 'Tool must have name');
    assert.ok(tool.description, 'Tool must have description');
    assert.ok(tool.inputSchema, 'Tool must have inputSchema');
    assert.strictEqual(tool.inputSchema.type, 'object');
    assert.ok(handlers.has(tool.name), `Handler must exist for ${tool.name}`);
  }

  // 3. Dynamic extension loading
  console.log('  3. Testing loadExtensions()...');
  const loaded = await loadExtensions(['law']);
  assert.strictEqual(loaded.length, 1);
  assert.strictEqual(loaded[0].name, 'law');

  // 4. Parameter validation without network
  console.log('  4. Testing input validation...');
  const emptyQueryRes = await searchOrdinances({ query: '' });
  assert.ok(emptyQueryRes.isError, 'Empty query should return isError: true');

  const emptySectionRes = await getSection({ section: '' });
  assert.ok(emptySectionRes.isError, 'Empty section should return isError: true');

  const emptyBriefRes = await draftGroundedBrief({});
  assert.ok(emptyBriefRes.isError, 'Missing facts and case_id should return isError: true');

  const emptyVerifyRes = await verifyAssertionGrounding({});
  assert.ok(emptyVerifyRes.isError, 'Missing draft_text should return isError: true');

  const emptyFlagRes = await flagStaleMemories({ section: '' });
  assert.ok(emptyFlagRes.isError, 'Missing section should return isError: true');

  const emptyResolveRes = await resolveStaleMemory({});
  assert.ok(emptyResolveRes.isError, 'Missing memory_id should return isError: true');

  // 5. Graceful offline degradation
  console.log('  5. Testing graceful offline handling...');
  // Force invalid port to test connection refusal handling
  const prevHost = process.env.KRUSCHLAW_API_URL;
  process.env.KRUSCHLAW_API_URL = 'http://127.0.0.1:59999';

  const offlineSearch = await searchOrdinances({ query: 'just cause eviction' });
  assert.ok(offlineSearch.isError, 'Offline search should flag isError');
  assert.ok(
    offlineSearch.content[0].text.includes('unreachable') || offlineSearch.content[0].text.includes('59999'),
    'Offline message should guide user to start service'
  );

  // Restore env
  if (prevHost) {
    process.env.KRUSCHLAW_API_URL = prevHost;
  } else {
    delete process.env.KRUSCHLAW_API_URL;
  }

  console.log('✅ All KruschLaw extension tests passed successfully!');
}

runTests().catch(err => {
  console.error('❌ Test failure:', err);
  process.exit(1);
});
