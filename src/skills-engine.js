import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { routeDiverseSkills } from '../../../lib/skiller.js';

const SKILLS_DIR = process.env.SKILLS_DIR || path.join(os.homedir(), 'homelab', 'skills');

// Regex to parse frontmatter and body
function parseSkillFile(content) {
    const match = content.match(/^---\r?\n([\s\S]+?)\r?\n---\r?\n([\s\S]*)$/);
    if (match) {
        const yamlPart = match[1];
        const body = match[2];
        const metadata = {};
        const lines = yamlPart.split(/\r?\n/);
        
        let currentKey = null;
        let currentValue = [];
        let isMultiline = false;

        for (const line of lines) {
            if (isMultiline) {
                // Check if the line is indented or empty
                if (line.startsWith(' ') || line.startsWith('\t') || line.trim() === '') {
                    currentValue.push(line.trim());
                    continue;
                } else {
                    // End multiline block, process key-value
                    metadata[currentKey] = currentValue.join(' ');
                    isMultiline = false;
                    currentKey = null;
                    currentValue = [];
                }
            }
            
            if (!isMultiline) {
                const separatorIndex = line.indexOf(':');
                if (separatorIndex !== -1) {
                    const key = line.substring(0, separatorIndex).trim();
                    let value = line.substring(separatorIndex + 1).trim();
                    
                    if (value === '>' || value === '|') {
                        currentKey = key;
                        isMultiline = true;
                    } else {
                        // Strip quotes if any
                        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                            value = value.substring(1, value.length - 1);
                        }
                        metadata[key] = value;
                    }
                }
            }
        }
        
        // If we finished the lines but were still in multiline mode
        if (isMultiline && currentKey) {
            metadata[currentKey] = currentValue.join(' ');
        }
        
        return { metadata, body };
    }
    return { metadata: {}, body: content };
}

// Recursively find all SKILL.md files
async function findSkillFiles(dir) {
    let results = [];
    let list;
    try {
        list = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
        console.error(`[skills-engine] Failed to read directory ${dir}:`, err.message);
        return results;
    }

    for (const file of list) {
        const res = path.resolve(dir, file.name);
        if (file.isDirectory()) {
            if (file.name !== 'node_modules' && file.name !== '.git') {
                const subResults = await findSkillFiles(res);
                results = results.concat(subResults);
            }
        } else if (file.name === 'SKILL.md') {
            results.push(res);
        }
    }
    return results;
}

// In-memory cache of skills
let skillsCache = new Map();

export async function loadSkills() {
    console.error(`[skills-engine] Loading skills from ${SKILLS_DIR}...`);
    const files = await findSkillFiles(SKILLS_DIR);
    const newCache = new Map();

    for (const file of files) {
        try {
            const relativePath = path.relative(SKILLS_DIR, file);
            const pathParts = relativePath.split(path.sep);
            
            // Skill name is usually the directory name containing SKILL.md
            const folderName = pathParts[pathParts.length - 2];
            const category = pathParts.length > 2 ? pathParts[0] : 'general';

            const content = await fs.readFile(file, 'utf-8');
            const { metadata, body } = parseSkillFile(content);

            const skillName = metadata.name || folderName;
            const skill = {
                name: skillName,
                description: metadata.description || '',
                argumentHint: metadata['argument-hint'] || null,
                category,
                filePath: file,
                body: body.trim(),
                metadata
            };

            newCache.set(skillName.toLowerCase(), skill);
        } catch (err) {
            console.error(`[skills-engine] Error parsing skill file ${file}:`, err.message);
        }
    }

    skillsCache = newCache;
    console.error(`[skills-engine] Successfully loaded ${skillsCache.size} skills.`);
}

export function listSkills() {
    return Array.from(skillsCache.values()).map(s => ({
        name: s.name,
        description: s.description,
        argumentHint: s.argumentHint,
        category: s.category
    }));
}

export function getSkill(name) {
    return skillsCache.get(name.toLowerCase()) || null;
}

/**
 * Diverse Skill Routing (DSR, arXiv: 2609.05824).
 * Selects an orthogonal, non-redundant set of skills matching the task query using DPP.
 *
 * @param {object} args
 * @param {string} args.query - Task or workflow query
 * @param {number} [args.max_skills=5] - Maximum number of skills to route
 * @param {number} [args.max_tokens=4000] - Token budget limit
 * @param {number} [args.diversity_lambda=0.6] - Trade-off between relevance (1.0) and diversity (0.0)
 * @returns {{content: Array<{type: string, text: string}>}}
 */
export function routeSkills(args = {}) {
    const { query, max_skills = 5, max_tokens = 4000, diversity_lambda = 0.6 } = args;
    if (!query) {
        throw new McpError(ErrorCode.InvalidParams, "Parameter 'query' is required for skill routing.");
    }
    const allSkills = Array.from(skillsCache.values()).map(s => ({
        name: s.name,
        description: s.description,
        category: s.category,
        tags: [s.category, ...(s.metadata?.tags || [])],
        argumentHint: s.argumentHint,
        body: s.body,
        tokens: Math.ceil((s.body?.length || 100) / 4)
    }));

    const result = routeDiverseSkills(query, allSkills, {
        maxSkills: max_skills,
        maxTokenBudget: max_tokens,
        diversityLambda: diversity_lambda
    });

    let text = `## 🎯 Diverse Skill Routing (DSR - arXiv: 2609.05824)\n`;
    text += `**Query**: "${query}" | **Diversity Score**: ${(result.diversityScore * 100).toFixed(1)}% | **Selected**: ${result.selectedSkills.length}\n\n`;

    for (const skill of result.selectedSkills) {
        text += `### 🛠️ ${skill.name} (${skill.category})\n`;
        text += `> ${skill.description}\n`;
        if (skill.argumentHint) text += `- **Argument Hint**: \`${skill.argumentHint}\`\n`;
        text += `- **Estimated Tokens**: ~${skill.tokens}\n\n`;
    }

    if (result.rejectedOverlap && result.rejectedOverlap.length > 0) {
        text += `### 🔄 Filtered Redundant Skills (${result.rejectedOverlap.length})\n`;
        for (const rej of result.rejectedOverlap) {
            text += `- **${rej.name}** (suppressed due to ${Math.round(rej.overlap * 100)}% overlap with *${rej.overlappingWith}*)\n`;
        }
    }

    return {
        content: [{ type: "text", text: text.trim() }]
    };
}
