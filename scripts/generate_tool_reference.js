import fs from 'fs';
import path from 'path';
import { CORE_TOOL_DEFINITIONS, EXTENDED_CORE_DEFINITIONS } from '../src/index.js';
import { getAvailableExtensionNames, resolveExtension } from '../src/extensions/index.js';

function formatToolTable(tool) {
  let md = `### \`${tool.name}\`\n\n`;
  md += `${tool.description}\n\n`;

  const props = tool.inputSchema?.properties || {};
  const req = tool.inputSchema?.required || [];
  
  if (Object.keys(props).length === 0) {
    md += `*(No parameters required)*\n\n`;
  } else {
    md += `| Parameter | Type | Required | Default | Description |\n`;
    md += `|-----------|------|----------|---------|-------------|\n`;
    for (const [pName, pSchema] of Object.entries(props)) {
      const isReq = req.includes(pName) ? '✅' : '❌';
      const def = pSchema.default !== undefined ? `\`${pSchema.default}\`` : '—';
      const desc = pSchema.description ? pSchema.description.replace(/\n/g, ' ') : '';
      md += `| \`${pName}\` | \`${pSchema.type || 'any'}\` | ${isReq} | ${def} | ${desc} |\n`;
    }
    md += `\n`;
  }
  return md;
}

let doc = `# 📋 Complete Tool Reference

> Every tool, every parameter, every default — everything an agent needs to call these tools correctly.
>
> For a high-level overview, see the [README](../README.md). For configuration and operational setups, see the [Setup Guide](SETUP.md).

---

## 🎯 Tool Profiles & Presets (\`KRUSCH_PROFILE\`)

To prevent agent context exhaustion and tool selection degradation, tools are organized into lean profile tiers and modular companion extensions:

- **\`core\` (Sovereign Default — 13 Tools)**: The lean, high-signal daily driver context engine (~900 prompt tokens). Covers hybrid retrieval, episodic memory hygiene, holographic nuggets, native symbol graphs, codebase search, server health, and proactive trajectory auditing.
- **\`extended\` (26 Tools Total)**: Core (13) plus complete memory administrative lifecycle (\`list\`, \`delete\`, \`update\`, \`consolidate\`), Git exploration (\`list_repos\`, \`read_tree\`, \`read_blob\`, \`file_symbols\`), composite search (\`deep_search\`), holographic forget/list, cited thinking (\`think\`), and proactive alignment feedback (\`nudge_feedback\`).
- **\`sovereign\` (37 Tools Total)**: The Sovereign Triad profile mounting Core (13) + Law (8) + Nexus (6) + Biz (7) + Semantic Router (3).
- **\`companion extensions\` (29 Tools across 5 modular extensions)**: Run independently as companion MCP servers or load on-demand via \`--extensions=...\` (\`law\`: 8, \`nexus\`: 6, \`biz\`: 7, \`polygres-cloud\`: 5, \`semantic-router\`: 3).
- *(Note: Experimental research engines — AgentDebugX, DataFlow, Setwise, AREX, ACM, Teacher Distillation, Resilience Gate — have been extracted to the dedicated companion package \`krusch-research-mcp\`)*.

Configure via \`KRUSCH_PROFILE=core\` in your \`.env\` or IDE MCP configuration, or pass \`--profile=core\` on the command line. Registered handlers for all tools remain executable on direct invocation regardless of the active profile.

---

## 🏛️ Architecture & PG-Git Engine Integration

Krusch Context MCP decouples into a 13-tool Core with modular companion extensions (up to **37 tools** in the Sovereign Triad profile, or 55 tools maximum across all extensions). It natively incorporates the complete codebase indexing and retrieval engine from **[PG-Git](https://github.com/kruschdev/pg-git)** (\`pg-git-mcp@1.1.0\`):
- **Native Git DAG Storage**: Stores Git trees, blobs, commits, and branches in PostgreSQL without requiring external file-system loose object scanning.
- **Structural Symbol Extraction**: Zero-dependency structural regex and brace-matching parser for JS, TS, Python, Go, Rust, and Shell to populate \`code_symbols\` and dependency edges in \`code_symbol_edges\`.
- **Hybrid RRF Search**: Merges dense pgvector cosine similarity with full-text lexical BM25 (\`tsv\` GIN index) using Reciprocal Rank Fusion and exponential temporal decay ($e^{-0.01t}$).
- **Shared Schema & Dual-Surface Aliases**: Shares identical PostgreSQL tables (\`repositories\`, \`blobs\`, \`code_symbols\`, \`code_symbol_edges\`, \`trees\`, \`commits\`, \`branches\`) with standalone PG-Git. Exposes first-class \`pg_git_*\` aliases (\`pg_git_search_symbols\`, \`pg_git_file_symbols\`, \`pg_git_dependency_graph\`) so standalone PG-Git workflows run seamlessly without reconfiguring agent prompts.

---

## ⚡ Core Profile (13 Tools — Sovereign Default)

The default 13-tool daily driver profile designed to fit within ~900 prompt tokens.

`;

for (const tool of CORE_TOOL_DEFINITIONS) {
  doc += formatToolTable(tool);
  doc += `---\n\n`;
}

doc += `## 🛠️ Extended Core Tools (+13 Tools = 26 Tools Total)

Administrative lifecycle, Git object inspection, cited thinking, and proactive alignment feedback.

`;

for (const tool of EXTENDED_CORE_DEFINITIONS) {
  doc += formatToolTable(tool);
  doc += `---\n\n`;
}

doc += `## 🌐 Modular Companion Extensions

Companion extensions provide targeted capabilities for specific project domains. Load via \`--extensions=<name>\` or select a profile preset like \`KRUSCH_PROFILE=sovereign\`.

`;

const extNames = getAvailableExtensionNames();
for (const extName of extNames) {
  const ext = resolveExtension(extName);
  doc += `### Extension: \`${extName}\` (${ext.tools.length} Tools)\n\n`;
  for (const tool of ext.tools) {
    doc += formatToolTable(tool);
  }
  doc += `---\n\n`;
}

fs.writeFileSync(path.join(process.cwd(), 'docs', 'TOOL_REFERENCE.md'), doc, 'utf-8');
console.log('Successfully wrote docs/TOOL_REFERENCE.md');
