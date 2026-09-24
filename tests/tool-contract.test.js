import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CORE_TOOLS,
  CORE_TOOL_DEFINITIONS,
  VERSION
} from '../src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

describe('Tool Contract & Invariant Suite', () => {
  it('Public tool surface must contain strictly the 5 canonical verbs', () => {
    assert.equal(CORE_TOOLS.size, 5, `Expected exactly 5 tools in Set, got ${CORE_TOOLS.size}`);
    assert.equal(CORE_TOOL_DEFINITIONS.length, 5, `Expected exactly 5 tool schemas, got ${CORE_TOOL_DEFINITIONS.length}`);

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

  it('Zero companion extensions or legacy engine modules are embedded', () => {
    const forbiddenSrcFiles = [
      'extensions',
      'git-engine.js',
      'ast-chunker.js',
      'skills-engine.js',
      'session-engine.js',
      'think-engine.js',
      'polygres-cloud.js',
      'v2-engine.js'
    ];

    for (const f of forbiddenSrcFiles) {
      const p = path.join(ROOT_DIR, 'src', f);
      assert.ok(!fs.existsSync(p), `Forbidden legacy module/directory '${f}' must not exist in src/`);
    }
  });

  it('Version consistency across package.json, code, and changelog', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf-8'));
    assert.equal(pkg.version, VERSION, `package.json version (${pkg.version}) must match src/index.js VERSION (${VERSION})`);

    const changelog = fs.readFileSync(path.join(ROOT_DIR, 'CHANGELOG.md'), 'utf-8');
    assert.ok(changelog.includes(`## [${VERSION}]`), `CHANGELOG.md must contain heading for ## [${VERSION}]`);
  });

  it('README and TOOL_REFERENCE advertise exactly the 5 canonical verbs', () => {
    const readme = fs.readFileSync(path.join(ROOT_DIR, 'README.md'), 'utf-8');
    const toolRef = fs.readFileSync(path.join(ROOT_DIR, 'docs', 'TOOL_REFERENCE.md'), 'utf-8');

    for (const verb of CORE_TOOLS) {
      assert.ok(readme.includes(verb), `README.md must mention canonical verb: ${verb}`);
      assert.ok(toolRef.includes(verb), `docs/TOOL_REFERENCE.md must document canonical verb: ${verb}`);
    }
  });

  it('Live active documentation must not contain stale tool-count claims', () => {
    const liveDocs = [
      path.join(ROOT_DIR, 'README.md'),
      path.join(ROOT_DIR, 'docs', 'TOOL_REFERENCE.md'),
      path.join(ROOT_DIR, 'docs', 'SETUP.md'),
      path.join(ROOT_DIR, 'docs', 'ARCHITECTURE.md'),
      path.join(ROOT_DIR, 'docs', 'EPISODIC_MEMORY.md'),
      path.join(ROOT_DIR, '.env.example')
    ];

    const forbiddenPatterns = [
      { pattern: /64\s+tools/i, label: 'stale 64 tools claim' },
      { pattern: /68\s+tools/i, label: 'stale 68 tools claim' },
      { pattern: /61\s+tools/i, label: 'stale 61 tools claim' },
      { pattern: /37\s+tools/i, label: 'stale 37 tools claim' },
      { pattern: /26\s+tools/i, label: 'stale 26 tools claim' },
      { pattern: /13\s+core\s+tools/i, label: 'stale 13 core tools claim' },
      { pattern: /13\s+tools/i, label: 'stale 13 tools claim' },
      { pattern: /--profile=/i, label: 'profile flag claim' },
      { pattern: /file:\/\/\/home\/krusch/i, label: 'leaked homelab file:/// link' }
    ];

    for (const filePath of liveDocs) {
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, 'utf-8');
      for (const { pattern, label } of forbiddenPatterns) {
        assert.ok(!pattern.test(content), `File ${path.relative(ROOT_DIR, filePath)} contains forbidden pattern: ${label}`);
      }
    }
  });

  it('Agent templates exist and enforce the 5-verb protocol', () => {
    const templates = [
      path.join(ROOT_DIR, 'templates', 'AGENTS.md'),
      path.join(ROOT_DIR, 'templates', '.cursorrules'),
      path.join(ROOT_DIR, 'templates', 'CLAUDE.md')
    ];

    for (const templatePath of templates) {
      assert.ok(fs.existsSync(templatePath), `Template must exist: ${templatePath}`);
      const content = fs.readFileSync(templatePath, 'utf-8');
      assert.ok(content.includes('retrieve'), `${path.basename(templatePath)} must include retrieve`);
      assert.ok(content.includes('remember'), `${path.basename(templatePath)} must include remember`);
      assert.ok(content.includes('revise'), `${path.basename(templatePath)} must include revise`);
      assert.ok(content.includes('nudge'), `${path.basename(templatePath)} must include nudge`);
      assert.ok(!content.includes('bge-m3'), `${path.basename(templatePath)} must not reference bge-m3`);
    }
  });

  it('CLI default configuration specifies bge-large and zero bge-m3 references', () => {
    const cliContent = fs.readFileSync(path.join(ROOT_DIR, 'bin', 'cli.js'), 'utf-8');
    assert.ok(cliContent.includes("bge-large"), 'bin/cli.js must default to bge-large');
    assert.ok(!cliContent.includes("bge-m3"), 'bin/cli.js must not reference bge-m3');
  });
});
