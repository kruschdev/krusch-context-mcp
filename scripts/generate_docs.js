/**
 * @module generate_docs
 * Generates canonical documentation (docs/TOOL_REFERENCE.md) directly from code tool definitions.
 * Eliminates documentation drift between code, README, and specs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_TOOL_DEFINITIONS, EXTENDED_CORE_DEFINITIONS, VERSION } from '../src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DOCS_DIR = path.resolve(__dirname, '../docs');
const OUTPUT_PATH = path.join(DOCS_DIR, 'TOOL_REFERENCE.md');

if (!fs.existsSync(DOCS_DIR)) {
    fs.mkdirSync(DOCS_DIR, { recursive: true });
}

function formatSchemaProperties(schema) {
    if (!schema || !schema.properties) return '_None_';
    const rows = [];
    const required = new Set(schema.required || []);

    for (const [propName, propDef] of Object.entries(schema.properties)) {
        const isReq = required.has(propName) ? '**Yes**' : 'No';
        const type = propDef.type || 'any';
        const desc = propDef.description || '';
        const def = propDef.default !== undefined ? ` (default: \`${propDef.default}\`)` : '';
        const enumVals = propDef.enum ? ` [${propDef.enum.join(', ')}]` : '';
        rows.push(`| \`${propName}\` | \`${type}\` | ${isReq} | ${desc}${enumVals}${def} |`);
    }

    if (rows.length === 0) return '_None_';
    return `| Parameter | Type | Required | Description |\n| :--- | :--- | :---: | :--- |\n` + rows.join('\n');
}

function generateMarkdown() {
    let md = `# Canonical Tool Reference (v${VERSION})\n\n`;
    md += `*This document is automatically generated from \`src/index.js\` via \`npm run docs:generate\`. Do not edit manually.*\n\n`;

    md += `## ⚡ Core 5 Verbs (\`core\` profile, default)\n\n`;
    md += `The default profile exposes strictly **5 canonical verbs** (~350 prompt tokens) for maximum reliability and zero tool soup:\n\n`;
    md += `| Tool Name | Short Alias | Primary Function |\n`;
    md += `| :--- | :--- | :--- |\n`;
    md += `| \`krusch_context_retrieve\` | \`retrieve\` | Hybrid context & state retrieval with strict token budget packing. |\n`;
    md += `| \`krusch_context_remember\` | \`remember\` | Unified write API for memories & steering nuggets with near-duplicate warning. |\n`;
    md += `| \`krusch_context_revise\` | \`revise\` | Temporal superseding and explicit invalidation with mandatory reason. |\n`;
    md += `| \`krusch_context_nudge\` | \`nudge\` | Pre-edit / pre-commit invariant auditor and alignment feedback weighting. |\n`;
    md += `| \`krusch_context_health\` | \`health\` | Operational diagnostics, closed-category counts, and 30-day TTL decay review. |\n\n`;

    md += `---\n\n## 🛠️ Detailed Verb Specifications\n\n`;

    for (const tool of CORE_TOOL_DEFINITIONS) {
        md += `### \`${tool.name}\`\n\n`;
        md += `**Description**: ${tool.description}\n\n`;
        md += `#### Parameters\n\n`;
        md += formatSchemaProperties(tool.inputSchema);
        md += `\n\n---\n\n`;
    }

    md += `## 📋 Extended Admin Tools (\`extended\` profile)\n\n`;
    md += `Tools available only when launched with \`--profile=extended\` for manual inspection and maintenance:\n\n`;

    for (const tool of EXTENDED_CORE_DEFINITIONS) {
        md += `### \`${tool.name}\`\n\n`;
        md += `**Description**: ${tool.description}\n\n`;
        md += `#### Parameters\n\n`;
        md += formatSchemaProperties(tool.inputSchema);
        md += `\n\n`;
    }

    return md;
}

const content = generateMarkdown();
fs.writeFileSync(OUTPUT_PATH, content, 'utf-8');
console.log(`✅ Generated canonical tool reference at ${OUTPUT_PATH} (${CORE_TOOL_DEFINITIONS.length} core, ${EXTENDED_CORE_DEFINITIONS.length} extended)`);
