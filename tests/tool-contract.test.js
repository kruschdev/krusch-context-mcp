import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CORE_TOOLS,
  EXTENDED_CORE_TOOLS,
  CORE_TOOL_DEFINITIONS,
  EXTENDED_CORE_DEFINITIONS
} from '../src/index.js';

import { getAvailableExtensionNames } from '../src/extensions/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

describe('Tool Contract & Profile Invariant Suite', () => {
  it('Core Profile must contain exactly 5 canonical verbs', () => {
    assert.equal(CORE_TOOLS.size, 5, `Expected 5 core tools in Set, got ${CORE_TOOLS.size}`);
    assert.equal(CORE_TOOL_DEFINITIONS.length, 5, `Expected 5 core tool schemas, got ${CORE_TOOL_DEFINITIONS.length}`);

    const expectedVerbs = new Set([
      'krusch_context_retrieve',
      'krusch_context_remember',
      'krusch_context_revise',
      'krusch_context_nudge',
      'krusch_context_health'
    ]);

    assert.deepEqual([...CORE_TOOLS].sort(), [...expectedVerbs].sort());

    // Verify schema names match Set members
    const defNames = new Set(CORE_TOOL_DEFINITIONS.map(d => d.name));
    for (const tool of CORE_TOOLS) {
      assert.ok(defNames.has(tool), `Core tool '${tool}' is missing a schema definition`);
    }
  });

  it('Extended Profile must contain exactly 4 admin inspection tools', () => {
    assert.equal(EXTENDED_CORE_TOOLS.size, 4, `Expected 4 extended tools in Set, got ${EXTENDED_CORE_TOOLS.size}`);
    assert.equal(EXTENDED_CORE_DEFINITIONS.length, 4, `Expected 4 extended schemas, got ${EXTENDED_CORE_DEFINITIONS.length}`);

    const defNames = new Set(EXTENDED_CORE_DEFINITIONS.map(d => d.name));
    for (const tool of EXTENDED_CORE_TOOLS) {
      assert.ok(defNames.has(tool), `Extended tool '${tool}' is missing a schema definition`);
    }
  });

  it('Core and Extended tool sets must have zero overlap', () => {
    const intersection = [...CORE_TOOLS].filter(t => EXTENDED_CORE_TOOLS.has(t));
    assert.deepEqual(intersection, [], `Collision detected between Core and Extended tools: ${intersection.join(', ')}`);
  });

  it('Zero companion extensions are embedded (companions live in separate repos)', () => {
    const available = getAvailableExtensionNames();
    assert.deepEqual(available, [], `Expected 0 companion extensions in core repo, found: ${available.join(', ')}`);
  });

  it('All tools across Core and Extended must have globally unique names', () => {
    const allNames = [...CORE_TOOLS, ...EXTENDED_CORE_TOOLS];
    assert.equal(allNames.length, 9, `Expected 9 total tool names, got ${allNames.length}`);
    const nameSet = new Set(allNames);
    assert.equal(nameSet.size, 9, `Duplicate tool names found! Unique count: ${nameSet.size}`);
  });

  it('Documentation must not contain stale tool-count claims', () => {
    const filesToAudit = [
      path.join(ROOT_DIR, 'docs', 'TOOL_REFERENCE.md')
    ];

    const forbiddenPatterns = [
      { pattern: /64 tools/i, label: 'stale 64 tools claim' },
      { pattern: /68 tools/i, label: 'stale 68 tools claim' },
      { pattern: /61 tools/i, label: 'stale 61 tools claim' },
      { pattern: /26\s+tools/i, label: 'stale 26 tools claim' },
      { pattern: /13\s+core\s+tools/i, label: 'stale 13 core tools claim' }
    ];

    for (const filePath of filesToAudit) {
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, 'utf-8');
      for (const { pattern, label } of forbiddenPatterns) {
        assert.ok(!pattern.test(content), `File ${path.basename(filePath)} contains forbidden pattern: ${label}`);
      }
    }
  });
});
