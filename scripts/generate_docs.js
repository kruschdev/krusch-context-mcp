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

const RETURN_SHAPES = {
    krusch_context_retrieve: `\`\`\`markdown
=== 🧠 Active Context Briefing ===
📦 Persistent Invariants & Steering Rules:
• [invariant] architecture.db_mode: SQLite by default with Node 22

📝 Relevant Episodic Memories:
[#42] (decision) | Relevance: 0.942 | file: src/index.js
Decision to standardize on 5 canonical verbs.

--- Budget: 412 / 4000 tokens used ---
\`\`\``,
    krusch_context_remember: `\`\`\`json
{
  "ok": true,
  "id": 43,
  "category": "decision",
  "content": "Use node:sqlite exclusively without native C++ compilation.",
  "warning": "near_duplicate (optional: if cosine >= 0.85)",
  "candidate": {
    "id": 12,
    "similarity": 0.88,
    "suggestion": "Call revise with action: 'supersede' to replace #12"
  }
}
\`\`\``,
    krusch_context_revise: `\`\`\`json
{
  "ok": true,
  "action": "supersede",
  "superseded_id": 12,
  "new_id": 43,
  "message": "Memory #12 marked as SUPERSEDED by #43. Lineage preserved."
}
\`\`\``,
    krusch_context_nudge: `\`\`\`json
{
  "ok": true,
  "trigger": "pre_commit",
  "findings_count": 1,
  "findings": [
    {
      "rule_id": "invariant-2",
      "category": "invariant",
      "severity": "warn",
      "evidence": "Found better-sqlite3 in package.json",
      "suggestion": "Standardize on node:sqlite built-in."
    }
  ]
}
\`\`\``,
    krusch_context_health: `\`\`\`json
{
  "status": "healthy",
  "version": "1.8.0",
  "storage": "sqlite",
  "database_path": "/workspace/.agent/context.db",
  "counts": {
    "total": 18,
    "decision": 7,
    "invariant": 4,
    "bug": 3,
    "lesson": 3,
    "blocker": 1
  },
  "decay_review": []
}
\`\`\``
};

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

    md += `---\n\n## 🔄 Legacy Alias → New Verb Mapping\n\n`;
    md += `For backward compatibility, legacy tool invocations are automatically intercepted and routed to the corresponding verb:\n\n`;
    md += `| Legacy Tool (v1.6 / v1.7) | Canonical Replacement (v1.8.0) | Notes |\n`;
    md += `| :--- | :--- | :--- |\n`;
    md += `| \`krusch_context_add_memory\` | \`krusch_context_remember({ content, category })\` | Enforces closed taxonomy |\n`;
    md += `| \`krusch_context_nugget_remember\` | \`krusch_context_remember({ key, content })\` | Sets persistent steering nugget |\n`;
    md += `| \`krusch_context_search_memory\` | \`krusch_context_retrieve({ query, mode: 'memory' })\` | Token budget packed |\n`;
    md += `| \`krusch_context_compile_state\` | \`krusch_context_retrieve({ query: '*', include_state: true })\` | Prepends state briefing |\n`;
    md += `| \`krusch_context_supersede_memory\` | \`krusch_context_revise({ action: 'supersede', target_id, content })\` | Preserves temporal lineage |\n`;
    md += `| \`krusch_context_invalidate_memory\` | \`krusch_context_revise({ action: 'invalidate', target_id, reason })\` | Mandatory reason required |\n`;
    md += `| \`krusch_context_nugget_forget\` | \`krusch_context_revise({ action: 'forget_nugget', key })\` | Retires persistent nugget |\n`;
    md += `| \`krusch_context_proactive_nudge\` | \`krusch_context_nudge({ trigger: 'pre_commit', code })\` | Capped at 3 findings |\n`;
    md += `| \`krusch_context_nudge_feedback\` | \`krusch_context_nudge({ action: 'feedback', rule_id, feedback })\` | Dynamic weight adjustment |\n`;
    md += `| \`krusch_context_nugget_nudges\` | \`krusch_context_retrieve({ query, category: 'invariant' })\` | Unified retrieval |\n\n`;

    md += `---\n\n## 🛠️ Detailed Verb Specifications\n\n`;

    for (const tool of CORE_TOOL_DEFINITIONS) {
        md += `### \`${tool.name}\`\n\n`;
        md += `**Description**: ${tool.description}\n\n`;
        md += `#### Parameters\n\n`;
        md += formatSchemaProperties(tool.inputSchema);
        md += `\n\n`;
        if (RETURN_SHAPES[tool.name]) {
            md += `#### Example Return Shape\n\n`;
            md += RETURN_SHAPES[tool.name];
            md += `\n\n`;
        }
        md += `---\n\n`;
    }

    md += `## 📋 Extended Admin Tools (\`--profile=extended\`)\n\n`;
    md += `Tools available only when launched with \`--profile=extended\` for manual maintenance:\n\n`;

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
