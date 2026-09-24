/**
 * @module generate_docs
 * Generates canonical documentation (docs/TOOL_REFERENCE.md) directly from code tool definitions.
 * Eliminates documentation drift between code, README, and specs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_TOOL_DEFINITIONS, VERSION } from '../src/index.js';

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
    "action": "Consider revise(action='supersede', target_id=12)"
  }
}
\`\`\``,
    krusch_context_revise: `\`\`\`json
{
  "ok": true,
  "action": "supersede",
  "target_id": 12,
  "new_id": 43,
  "lineage": {
    "supersedes_id": 12,
    "status": "SUPERSEDED"
  }
}
\`\`\``,
    krusch_context_nudge: `\`\`\`markdown
🛡️ Pre-Commit Invariant Findings (2 active constraints checked):
1. [VIOLATION] invariant:db_query_parameterization
   Line 42 of src/db.js contains raw string template in query.
   Recommendation: Use parameterized $1 bindings.
\`\`\``,
    krusch_context_health: `\`\`\`markdown
=== 🏥 Krusch Context MCP Health Report ===
* Store Mode: SQLite (.agent/context.db)
* Total Active Memories: 142
  - Decisions: 38
  - Invariants: 44
  - Bugs: 22
  - Lessons: 31
  - Blockers: 7
* Memories > 30 Days Old: 14 (candidates for review or invalidation)
* Status: HEALTHY (Operational)
\`\`\``
};

function generateMarkdown() {
    let md = `# 📖 Krusch Context MCP Tool Reference (v${VERSION})\n\n`;
    md += `> Auto-generated from source definitions in \`src/index.js\`. Run \`npm run docs:generate\` to synchronize.\n\n`;
    md += `Krusch Context MCP enforces a strict **5-verb public contract** (~350 prompt tokens) to maximize host agent accuracy and eliminate tool hallucination.\n\n`;

    md += `## ⚡ The 5 Canonical Verbs\n\n`;
    md += `| Verb | Short Alias | Purpose |\n`;
    md += `| :--- | :--- | :--- |\n`;
    md += `| \`krusch_context_retrieve\` | \`retrieve\` | Hydrate project decisions, invariants, and state briefings within a strict token budget. |\n`;
    md += `| \`krusch_context_remember\` | \`remember\` | Persist lasting facts with closed categories (\`decision\`, \`bug\`, \`invariant\`, \`lesson\`, \`blocker\`) and duplicate warning. |\n`;
    md += `| \`krusch_context_revise\` | \`revise\` | Update facts via temporal superseding (\`supersede\`) or retire rules with mandatory justification (\`invalidate\`). |\n`;
    md += `| \`krusch_context_nudge\` | \`nudge\` | Pre-edit / pre-commit invariant auditor and alignment feedback weighting. |\n`;
    md += `| \`krusch_context_health\` | \`health\` | Operational diagnostics, closed-category counts, and 30-day TTL decay review. |\n\n`;

    md += `---\n\n## 🔄 Internal Alias Mapping\n\n`;
    md += `For backward compatibility, host agent aliases and legacy invocations are automatically intercepted and routed to the corresponding verb:\n\n`;
    md += `| Invocation / Alias | Canonical Replacement | Notes |\n`;
    md += `| :--- | :--- | :--- |\n`;
    md += `| \`retrieve\` | \`krusch_context_retrieve\` | Direct shorthand |\n`;
    md += `| \`remember\` | \`krusch_context_remember\` | Direct shorthand |\n`;
    md += `| \`revise\` | \`krusch_context_revise\` | Direct shorthand |\n`;
    md += `| \`nudge\` | \`krusch_context_nudge\` | Direct shorthand |\n`;
    md += `| \`health\` | \`krusch_context_health\` | Direct shorthand |\n`;
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

    return md;
}

const content = generateMarkdown();
fs.writeFileSync(OUTPUT_PATH, content, 'utf-8');
console.log(`✅ Generated canonical tool reference at ${OUTPUT_PATH} (${CORE_TOOL_DEFINITIONS.length} canonical verbs)`);
