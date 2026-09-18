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

import { tools as researchTools } from '../src/extensions/research/index.js';
import { tools as companyBrainTools } from '../src/extensions/company-brain/index.js';
import { tools as cloudTools } from '../src/extensions/polygres-cloud/index.js';
import { tools as sessionTools } from '../src/extensions/session-bridge/index.js';
import { tools as skillsTools } from '../src/extensions/skills-docs/index.js';

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

  it('Companion extensions must export exact registered tool counts (35 tools total)', () => {
    assert.equal(researchTools.length, 15, `Expected 15 research tools, got ${researchTools.length}`);
    assert.equal(companyBrainTools.length, 8, `Expected 8 company-brain tools, got ${companyBrainTools.length}`);
    assert.equal(cloudTools.length, 5, `Expected 5 polygres-cloud tools, got ${cloudTools.length}`);
    assert.equal(skillsTools.length, 5, `Expected 5 skills-docs tools, got ${skillsTools.length}`);
    assert.equal(sessionTools.length, 2, `Expected 2 session-bridge tools, got ${sessionTools.length}`);

    const totalCompanion = researchTools.length + companyBrainTools.length + cloudTools.length + skillsTools.length + sessionTools.length;
    assert.equal(totalCompanion, 35, `Expected exactly 35 companion extension tools, got ${totalCompanion}`);
  });

  it('Full monolithic profile must contain exactly 61 tools (26 Core/Extended + 35 Extensions)', () => {
    const total = CORE_TOOLS.size + EXTENDED_CORE_TOOLS.size +
      researchTools.length + companyBrainTools.length + cloudTools.length + skillsTools.length + sessionTools.length;
    assert.equal(total, 61, `Expected exactly 61 tools in full suite, got ${total}`);
  });

  it('All 61 tools across all profiles and extensions must have globally unique names', () => {
    const allNames = [
      ...CORE_TOOLS,
      ...EXTENDED_CORE_TOOLS,
      ...researchTools.map(t => t.name),
      ...companyBrainTools.map(t => t.name),
      ...cloudTools.map(t => t.name),
      ...skillsTools.map(t => t.name),
      ...sessionTools.map(t => t.name)
    ];

    assert.equal(allNames.length, 61, `Expected 61 total tool names, got ${allNames.length}`);
    const nameSet = new Set(allNames);
    assert.equal(nameSet.size, 61, `Duplicate tool names found! Unique count: ${nameSet.size}`);
  });

  it('Documentation must not contain stale tool-count claims (e.g. 64 tools, 18 with cloud, 31 with cloud)', () => {
    const filesToAudit = [
      path.join(ROOT_DIR, 'README.md'),
      path.join(ROOT_DIR, 'AGENTS.md'),
      path.join(ROOT_DIR, 'docs', 'TOOL_REFERENCE.md'),
      path.join(ROOT_DIR, 'docs', 'cloud_integration_post.md'),
      path.join(ROOT_DIR, 'docs', 'polygres_050_announcement_post.md')
    ];

    const forbiddenPatterns = [
      { pattern: /64 tools/i, label: 'stale 64 tools claim' },
      { pattern: /18\s+tools\s+with\s+polygres/i, label: 'stale 18 tools with cloud claim' },
      { pattern: /31\s+with\s+polygres/i, label: 'stale 31 with cloud claim' },
      { pattern: /11\s+core\s+tools/i, label: 'stale 11 core tools claim' }
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
