/**
 * @module extensions/skills-docs
 * Agent Skills Registry & External Documentation Extension for krusch-context-mcp.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadSkills, listSkills, getSkill, routeSkills } from './skills-engine.js';
import { getEmbedding } from '../../embedding-helper.js';
import { searchBlobs } from '../../git-engine.js';
import { pool } from '../../../db/pool.js';
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

async function handleListSkills() {
  const skills = listSkills();
  let output = `=== 🛠️ Agent Skills Registry (${skills.length}) ===\n`;
  for (const s of skills) {
    output += `\n- Name: ${s.name}\n  Category: ${s.category}\n  Description: ${s.description}\n`;
    if (s.argumentHint) {
      output += `  Argument hint: ${s.argumentHint}\n`;
    }
  }
  return { content: [{ type: "text", text: output }] };
}

async function handleGetSkill(args) {
  const { name } = args;
  const skill = getSkill(name);
  if (!skill) {
    return { content: [{ type: "text", text: `Skill '${name}' not found.` }], isError: true };
  }
  let output = `=== 🛠️ Skill: ${skill.name} (${skill.category}) ===\n`;
  output += `Description: ${skill.description}\n\n`;
  output += skill.body;
  return { content: [{ type: "text", text: output }] };
}

async function handleDocsList() {
  const configPath = process.env.EXTERNAL_DOCS_CONFIG_PATH || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../config/external_docs.json');
  try {
    const fileContent = await fs.readFile(configPath, 'utf-8');
    const configData = JSON.parse(fileContent);
    if (!Array.isArray(configData) || configData.length === 0) {
        return { content: [{ type: "text", text: "No manuals available." }] };
    }
    let output = `=== 📚 Available External Manuals ===\n`;
    for (const doc of configData) {
        output += `\n- ${doc.name} (Source: ${doc.url})`;
    }
    return { content: [{ type: "text", text: output }] };
  } catch (e) {
    return { content: [{ type: "text", text: "No external manuals configured." }] };
  }
}

async function handleDocsSearch(args) {
  const { manual_name, query: searchQuery, limit = 5 } = args;
  
  const repoRes = await pool.query(`SELECT id FROM repositories WHERE name = $1`, [manual_name]);
  if (repoRes.rows.length === 0) {
      return { content: [{ type: "text", text: `Manual '${manual_name}' not found in database. Use krusch_docs_list to see available manuals.` }] };
  }
  const resolvedRepoId = repoRes.rows[0].id;
  
  const vector = await getEmbedding(searchQuery);
  if (!vector) throw new McpError(ErrorCode.InternalError, "Failed to generate embedding");
  
  const results = await searchBlobs(vector, limit, resolvedRepoId, searchQuery);
  if (results.length === 0) return { content: [{ type: "text", text: "No relevant documentation found." }] };
  
  let output = `=== 📖 Documentation Search: ${manual_name} ===\n`;
  for (const r of results) {
      const pathStr = r.file_path ? ` [${r.file_path}]` : '';
      output += `\n--- Match (Score: ${Number(r.similarity).toFixed(2)})${pathStr} ---\n`;
      output += (r.summary || '(no preview)') + '\n';
  }
  return { content: [{ type: "text", text: output }] };
}

export const tools = [
  {
    name: "krusch_context_list_skills",
    description: "List all available AI agent skills (TDD, Diagnose, Handoff, Caveman, etc.) loaded from the homelab registry.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "krusch_context_get_skill",
    description: "Retrieve a specific AI agent skill's markdown prompt instructions by name.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The name of the skill to retrieve (e.g. 'tdd', 'diagnose', 'caveman', 'grill-with-docs')" }
      },
      required: ["name"]
    }
  },
  {
    name: "krusch_context_route_skills",
    description: "Diverse Skill Routing (DSR - arXiv: 2609.05824): Deterministically select a diverse, non-redundant set of agent skills for a task using MMR.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The prompt, task description, or user goal to route skills for" },
        max_skills: { type: "number", default: 3, description: "Maximum number of diverse skills to select" },
        diversity_lambda: { type: "number", default: 0.6, description: "MMR diversity trade-off (1.0 = pure relevance, 0.0 = maximal diversity)" }
      },
      required: ["query"]
    }
  },
  {
    name: "krusch_docs_list",
    description: "List all configured external software documentation manuals in the homelab index.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "krusch_docs_search",
    description: "Search indexed external documentation manuals using hybrid semantic and keyword search.",
    inputSchema: {
      type: "object",
      properties: {
        manual_name: { type: "string", description: "The exact name of the manual (e.g. anthropic-docs)" },
        query: { type: "string", description: "The search query" },
        limit: { type: "number", default: 5 }
      },
      required: ["manual_name", "query"]
    }
  }
];

export const handlers = new Map([
  ['krusch_context_list_skills', () => handleListSkills()],
  ['krusch_context_get_skill', (args) => handleGetSkill(args)],
  ['krusch_context_route_skills', (args) => routeSkills(args)],
  ['krusch_docs_list', () => handleDocsList()],
  ['krusch_docs_search', (args) => handleDocsSearch(args)]
]);

export const extension = {
  name: "skills-docs",
  description: "Agent Skills Registry & External Documentation Search — prompt templates, Diverse Skill Routing (DSR), and indexed manuals.",
  init: async () => {
    await loadSkills();
  },
  tools,
  handlers
};

export default extension;
