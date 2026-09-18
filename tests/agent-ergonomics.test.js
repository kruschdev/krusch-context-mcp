import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import { detectCurrentProject, getWorktreeStatus } from '../src/project-helper.js';
import { compileProjectState } from '../src/memory-engine.js';
import { unifiedRetrieve } from '../src/unified-retrieval.js';
import { CORE_PROMPTS } from '../src/index.js';
import { pool } from '../db/pool.js';

describe('Agent Ergonomics & Streamlining Suite', () => {
  it('detectCurrentProject should resolve to current repo name', () => {
    const project = detectCurrentProject();
    assert.ok(project, 'Should detect a project name');
    assert.equal(project, 'krusch-context-mcp', 'Should detect krusch-context-mcp from package.json or git root');
  });

  it('getWorktreeStatus should report worktree status without throwing', () => {
    const status = getWorktreeStatus();
    assert.equal(typeof status.isDirty, 'boolean');
    assert.equal(typeof status.modifiedCount, 'number');
    if (status.isDirty) {
      assert.ok(status.message && status.message.includes('uncommitted or modified file(s)'));
    }
  });

  it('compileProjectState should succeed without explicit project argument (auto-detection)', async () => {
    const res = await compileProjectState({});
    assert.ok(res && res.content && res.content[0]?.text);
    const text = res.content[0].text;
    assert.ok(text.includes('Compiled Project State: krusch-context-mcp'), `Expected auto-detected header, got: ${text.slice(0, 100)}`);
    assert.ok(text.includes('Priorities'), 'Should include priorities section');
  });

  it('unifiedRetrieve with include_state=true should pack state briefing into response', async () => {
    const res = await unifiedRetrieve({
      query: 'database pool and timeouts',
      include_state: true,
      limit_tokens: 4000
    });

    assert.ok(res && res.content && res.content[0]?.text);
    const text = res.content[0].text;
    assert.ok(text.includes('Unified Context Retrieval'), `Should contain retrieval header: ${text}`);
    assert.ok(text.includes('State Included'), 'Header should confirm state included');
    assert.ok(text.includes('Compiled Project State: krusch-context-mcp'), 'Should prepend compiled project state');
  });

  it('CORE_PROMPTS should provide session_start and pre_commit prompts', () => {
    assert.equal(CORE_PROMPTS.length, 2, 'Should define 2 core MCP prompts');
    const promptNames = CORE_PROMPTS.map(p => p.name);
    assert.ok(promptNames.includes('session_start'), 'Should have session_start prompt');
    assert.ok(promptNames.includes('pre_commit'), 'Should have pre_commit prompt');

    const sessionStart = CORE_PROMPTS.find(p => p.name === 'session_start');
    const msgs = sessionStart.generateMessages({});
    assert.ok(msgs.length > 0);
    assert.ok(msgs[0].content.text.includes('krusch_context_compile_state'));

    const preCommit = CORE_PROMPTS.find(p => p.name === 'pre_commit');
    const commitMsgs = preCommit.generateMessages({});
    assert.ok(commitMsgs.length > 0);
    assert.ok(commitMsgs[0].content.text.includes('krusch_context_nugget_nudges'));
  });

  after(async () => {
    await pool.end();
  });
});
