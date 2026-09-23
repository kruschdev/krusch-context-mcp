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

import { tools as nexusTools } from '../src/extensions/nexus/index.js';
import { tools as bizTools } from '../src/extensions/biz/index.js';
import { tools as lawTools } from '../src/extensions/law/index.js';
import { tools as routerTools } from '../src/extensions/semantic-router/index.js';
import { tools as cloudTools } from '../src/extensions/polygres-cloud/index.js';
import { getAvailableExtensionNames } from '../src/extensions/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

describe('Tool Contract & Profile Invariant Suite', () => {
  it('Core Profile must contain exactly 13 curated daily drivers', () => {
    assert.equal(CORE_TOOLS.size, 13, `Expected 13 core tools in Set, got ${CORE_TOOLS.size}`);
    assert.equal(CORE_TOOL_DEFINITIONS.length, 13, `Expected 13 core tool schemas, got ${CORE_TOOL_DEFINITIONS.length}`);

    // Verify schema names match Set members
    const defNames = new Set(CORE_TOOL_DEFINITIONS.map(d => d.name));
    for (const tool of CORE_TOOLS) {
      assert.ok(defNames.has(tool), `Core tool '${tool}' is missing a schema definition`);
    }
  });

  it('Extended Core Profile must contain exactly 13 inspection tools (26 total with Core)', () => {
    assert.equal(EXTENDED_CORE_TOOLS.size, 13, `Expected 13 extended core tools in Set, got ${EXTENDED_CORE_TOOLS.size}`);
    assert.equal(EXTENDED_CORE_DEFINITIONS.length, 13, `Expected 13 extended tool schemas, got ${EXTENDED_CORE_DEFINITIONS.length}`);

    // Verify schema names match Set members
    const defNames = new Set(EXTENDED_CORE_DEFINITIONS.map(d => d.name));
    for (const tool of EXTENDED_CORE_TOOLS) {
      assert.ok(defNames.has(tool), `Extended tool '${tool}' is missing a schema definition`);
    }
  });

  it('Core and Extended tool sets must have zero overlap', () => {
    const intersection = [...CORE_TOOLS].filter(t => EXTENDED_CORE_TOOLS.has(t));
    assert.deepEqual(intersection, [], `Collision detected between Core and Extended tools: ${intersection.join(', ')}`);
  });

  it('Sovereign Triad and Polygres extensions export exact registered tool counts (29 tools total)', () => {
    assert.equal(nexusTools.length, 6, `Expected 6 nexus tools, got ${nexusTools.length}`);
    assert.equal(bizTools.length, 7, `Expected 7 biz tools, got ${bizTools.length}`);
    assert.equal(lawTools.length, 8, `Expected 8 law tools, got ${lawTools.length}`);
    assert.equal(routerTools.length, 3, `Expected 3 router tools, got ${routerTools.length}`);
    assert.equal(cloudTools.length, 5, `Expected 5 polygres-cloud tools, got ${cloudTools.length}`);

    const totalSovereignQuartet = nexusTools.length + bizTools.length + lawTools.length + routerTools.length;
    assert.equal(totalSovereignQuartet, 24, `Expected 24 tools in Sovereign Quartet, got ${totalSovereignQuartet}`);

    const totalAvailable = totalSovereignQuartet + cloudTools.length;
    assert.equal(totalAvailable, 29, `Expected 29 companion extension tools, got ${totalAvailable}`);
  });

  it('Only production companion extensions are registered (zero experimental research bloat)', () => {
    const available = getAvailableExtensionNames();
    assert.deepEqual(
      available.sort(),
      ['biz', 'law', 'nexus', 'polygres-cloud', 'semantic-router'].sort(),
      'Available extensions must only contain production companions'
    );
    assert.ok(!available.includes('research'), 'Research extension must not be registered');
    assert.ok(!available.includes('skills-docs'), 'Skills-docs extension must not be registered');
    assert.ok(!available.includes('session-bridge'), 'Session-bridge extension must not be registered');
    assert.ok(!available.includes('company-brain'), 'Company-brain extension must not be registered');
  });

  it('All tools across Core, Extended, and Companions must have globally unique names', () => {
    const allNames = [
      ...CORE_TOOLS,
      ...EXTENDED_CORE_TOOLS,
      ...nexusTools.map(t => t.name),
      ...bizTools.map(t => t.name),
      ...lawTools.map(t => t.name),
      ...routerTools.map(t => t.name),
      ...cloudTools.map(t => t.name)
    ];

    assert.equal(allNames.length, 55, `Expected 55 total tool names, got ${allNames.length}`);
    const nameSet = new Set(allNames);
    assert.equal(nameSet.size, 55, `Duplicate tool names found! Unique count: ${nameSet.size}`);
  });

  it('Documentation must not contain stale tool-count claims', () => {
    const filesToAudit = [
      path.join(ROOT_DIR, 'README.md'),
      path.join(ROOT_DIR, 'AGENTS.md'),
      path.join(ROOT_DIR, '.env.example'),
      path.join(ROOT_DIR, 'docs', 'TOOL_REFERENCE.md')
    ];

    const forbiddenPatterns = [
      { pattern: /64 tools/i, label: 'stale 64 tools claim' },
      { pattern: /68 tools/i, label: 'stale 68 tools claim' },
      { pattern: /61 tools/i, label: 'stale 61 tools claim' },
      { pattern: /18\s+tools\s+with\s+polygres/i, label: 'stale 18 tools with cloud claim' },
      { pattern: /31\s+with\s+polygres/i, label: 'stale 31 with cloud claim' },
      { pattern: /11\s+core\s+tools/i, label: 'stale 11 core tools claim' },
      { pattern: /25\s+tools/i, label: 'stale 25 tools extended claim' }
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
