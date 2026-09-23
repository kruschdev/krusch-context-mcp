/**
 * Test suite for KruschBiz companion extension in krusch-context-mcp.
 * Validates extension registration, tool schemas, handler bindings,
 * and graceful degradation behavior.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getAvailableExtensionNames, resolveExtension, loadExtensions } from '../src/extensions/index.js';
import { tools, handlers, extension } from '../src/extensions/biz/index.js';
import {
  searchContracts,
  getClauseDetails,
  resolveControllingClause,
  detectContractConflicts,
  diffInstruments,
  draftDealBrief,
  listDeals
} from '../src/extensions/biz/biz-engine.js';

describe('KruschBiz Companion Extension Suite', () => {
  it('1. Extension registration and aliases', () => {
    const available = getAvailableExtensionNames();
    assert.ok(available.includes('biz'), 'Extension "biz" should be listed in available extensions');

    const direct = resolveExtension('biz');
    assert.ok(direct, 'resolveExtension("biz") must return extension object');
    assert.equal(direct.name, 'biz');

    const aliasBiz = resolveExtension('krusch-biz');
    assert.ok(aliasBiz, 'resolveExtension("krusch-biz") alias must return extension object');

    const aliasCorporate = resolveExtension('corporate');
    assert.ok(aliasCorporate, 'resolveExtension("corporate") alias must return extension object');
  });

  it('2. Tool definitions and schemas', () => {
    assert.equal(tools.length, 7, 'Should expose exactly 7 KruschBiz tools');

    const expectedTools = [
      'krusch_biz_search_contracts',
      'krusch_biz_get_clause',
      'krusch_biz_resolve_controlling_clause',
      'krusch_biz_detect_conflicts',
      'krusch_biz_diff_instruments',
      'krusch_biz_draft_deal_brief',
      'krusch_biz_list_deals'
    ];

    for (const toolName of expectedTools) {
      const tool = tools.find(t => t.name === toolName);
      assert.ok(tool, `Tool '${toolName}' must exist in schema list`);
      assert.ok(tool.description, `Tool '${toolName}' must have a description`);
      assert.ok(tool.inputSchema, `Tool '${toolName}' must have inputSchema`);
      assert.equal(tool.inputSchema.type, 'object');
      assert.ok(handlers.has(toolName), `Handler must exist for '${toolName}'`);
    }
  });

  it('3. Dynamic extension loading', async () => {
    const loaded = await loadExtensions(['biz']);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].name, 'biz');
  });

  it('4. Parameter validation without network', async () => {
    const emptySearch = await searchContracts({ query: '' });
    assert.ok(emptySearch.isError, 'Empty search query should return isError: true');

    const emptyClause = await getClauseDetails({ section: '' });
    assert.ok(emptyClause.isError, 'Empty section should return isError: true');

    const emptyControlling = await resolveControllingClause({});
    assert.ok(emptyControlling.isError, 'Missing counterparty and topic should return isError: true');

    const emptyConflicts = await detectContractConflicts({});
    assert.ok(emptyConflicts.isError, 'Missing counterparty should return isError: true');

    const emptyDiff = await diffInstruments({});
    assert.ok(emptyDiff.isError, 'Missing agreement IDs should return isError: true');

    const emptyDraft = await draftDealBrief({});
    assert.ok(emptyDraft.isError, 'Missing context_facts and deal_id should return isError: true');
  });

  it('5. Graceful offline degradation', async () => {
    const prevHost = process.env.KRUSCHBIZ_API_URL;
    process.env.KRUSCHBIZ_API_URL = 'http://127.0.0.1:59997';

    const offlineSearch = await searchContracts({ query: 'limitation of liability' });
    assert.ok(offlineSearch.isError, 'Offline search should flag isError');
    assert.ok(
      offlineSearch.content[0].text.includes('unreachable') || offlineSearch.content[0].text.includes('59997'),
      'Offline message should guide user to start service'
    );

    if (prevHost) {
      process.env.KRUSCHBIZ_API_URL = prevHost;
    } else {
      delete process.env.KRUSCHBIZ_API_URL;
    }
  });
});
