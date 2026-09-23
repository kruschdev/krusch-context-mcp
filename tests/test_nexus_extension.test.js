/**
 * Test suite for KruschNexus companion extension in krusch-context-mcp.
 * Validates extension registration, tool schemas, handler bindings,
 * and graceful degradation behavior.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getAvailableExtensionNames, resolveExtension, loadExtensions } from '../src/extensions/index.js';
import { tools, handlers, extension } from '../src/extensions/nexus/index.js';
import {
  listWorkspaces,
  listDocuments,
  searchCorpus,
  getIngestReport,
  ingestFile,
  verifySpan
} from '../src/extensions/nexus/nexus-engine.js';

describe('KruschNexus Companion Extension Suite', () => {
  it('1. Extension registration and aliases', () => {
    const available = getAvailableExtensionNames();
    assert.ok(available.includes('nexus'), 'Extension "nexus" should be listed in available extensions');

    const direct = resolveExtension('nexus');
    assert.ok(direct, 'resolveExtension("nexus") must return extension object');
    assert.equal(direct.name, 'nexus');

    const aliasNexus = resolveExtension('krusch-nexus');
    assert.ok(aliasNexus, 'resolveExtension("krusch-nexus") alias must return extension object');

    const aliasCitation = resolveExtension('citation');
    assert.ok(aliasCitation, 'resolveExtension("citation") alias must return extension object');
  });

  it('2. Tool definitions and schemas', () => {
    assert.equal(tools.length, 6, 'Should expose exactly 6 KruschNexus tools');

    const expectedTools = [
      'krusch_nexus_list_workspaces',
      'krusch_nexus_list_documents',
      'krusch_nexus_search_corpus',
      'krusch_nexus_get_ingest_report',
      'krusch_nexus_ingest_file',
      'krusch_nexus_verify_span'
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
    const loaded = await loadExtensions(['nexus']);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].name, 'nexus');
  });

  it('4. Parameter validation without network', async () => {
    const emptySearch = await searchCorpus({ query: '', workspace_name: '' });
    assert.ok(emptySearch.isError, 'Empty search query should return isError: true');

    const noWorkspaceSearch = await searchCorpus({ query: 'test query', workspace_name: '' });
    assert.ok(noWorkspaceSearch.isError, 'Missing workspace_name should return isError: true');

    const emptyReport = await getIngestReport({});
    assert.ok(emptyReport.isError, 'Missing doc_id_or_hash should return isError: true');

    const emptyIngest = await ingestFile({});
    assert.ok(emptyIngest.isError, 'Missing file_path should return isError: true');

    const nonExistentIngest = await ingestFile({ file_path: '/tmp/nonexistent_file_xyz_123.pdf', workspace_name: 'test' });
    assert.ok(nonExistentIngest.isError, 'Nonexistent file should return isError: true');

    const emptyVerify = await verifySpan({});
    assert.ok(emptyVerify.isError, 'Missing workspace_name and query should return isError: true');
  });

  it('5. Graceful offline degradation', async () => {
    const prevHost = process.env.NEXUS_API_URL;
    process.env.NEXUS_API_URL = 'http://127.0.0.1:59998';

    const offlineWorkspaces = await listWorkspaces();
    assert.ok(offlineWorkspaces.isError, 'Offline workspaces query should flag isError');
    assert.ok(
      offlineWorkspaces.content[0].text.includes('unreachable') || offlineWorkspaces.content[0].text.includes('59998'),
      'Offline message should guide user to start service'
    );

    if (prevHost) {
      process.env.NEXUS_API_URL = prevHost;
    } else {
      delete process.env.NEXUS_API_URL;
    }
  });
});
