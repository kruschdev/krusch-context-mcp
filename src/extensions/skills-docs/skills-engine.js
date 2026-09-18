import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

const SKILLS_DIR = process.env.SKILLS_DIR || path.join(os.homedir(), 'homelab', 'skills');

/**
 * Computes word-vector overlap similarity between two text snippets (Jaccard / Token-Set).
 */
function computeTextSimilarity(textA = '', textB = '') {
    const setA = new Set(textA.toLowerCase().replace(/[^a-z0-9\s_-]/g, ' ').split(/\s+/).filter(w => w.length > 2));
    const setB = new Set(textB.toLowerCase().replace(/[^a-z0-9\s_-]/g, ' ').split(/\s+/).filter(w => w.length > 2));

    if (setA.size === 0 || setB.size === 0) return 0.0;
    let intersection = 0;
    for (const w of setA) {
        if (setB.has(w)) intersection++;
    }
    const union = new Set([...setA, ...setB]).size;
    return union === 0 ? 0.0 : intersection / union;
}

/**
 * Diverse Skill Routing (DSR - arXiv: 2609.05824).
 * Balances query relevance and pairwise non-redundancy to construct a complementary skill set.
 */
export function routeDiverseSkills(query, availableSkills = [], options = {}) {
    const {
        maxSkills = 5,
        maxTokenBudget = 4000,
        diversityLambda = 0.6,
        similarityFn = computeTextSimilarity
    } = options;

    if (!Array.isArray(availableSkills) || availableSkills.length === 0) {
        return { selectedSkills: [], totalTokens: 0, diversityScore: 1.0, rejectedOverlap: [] };
    }

    const candidates = availableSkills.map(skill => {
        const fullSkillText = `${skill.name} ${skill.description || ''} ${(skill.tags || []).join(' ')}`;
        const relevance = similarityFn(query, fullSkillText);
        const tokens = skill.tokens || Math.max(100, Math.round(fullSkillText.length / 4));
        return {
            ...skill,
            fullSkillText,
            relevance,
            tokens
        };
    });

    candidates.sort((a, b) => b.relevance - a.relevance);

    const selectedSkills = [];
    const rejectedOverlap = [];
    let currentTokens = 0;

    const remaining = [...candidates];

    while (remaining.length > 0 && selectedSkills.length < maxSkills) {
        let bestIndex = -1;
        let bestScore = -Infinity;

        for (let i = 0; i < remaining.length; i++) {
            const candidate = remaining[i];

            if (currentTokens + candidate.tokens > maxTokenBudget) {
                continue;
            }

            let maxRedundancy = 0;
            for (const sel of selectedSkills) {
                const redundancy = similarityFn(candidate.fullSkillText, sel.fullSkillText);
                if (redundancy > maxRedundancy) {
                    maxRedundancy = redundancy;
                }
            }

            const dsrScore = (diversityLambda * candidate.relevance) - ((1 - diversityLambda) * maxRedundancy);

            if (dsrScore > bestScore) {
                bestScore = dsrScore;
                bestIndex = i;
            }
        }

        if (bestIndex === -1) break;

        const chosen = remaining.splice(bestIndex, 1)[0];

        let maxOverlap = 0;
        let overlappingSkill = null;
        for (const sel of selectedSkills) {
            const sim = similarityFn(chosen.fullSkillText, sel.fullSkillText);
            if (sim > maxOverlap) {
                maxOverlap = sim;
                overlappingSkill = sel.name;
            }
        }

        if (maxOverlap > 0.85 && selectedSkills.length > 0) {
            rejectedOverlap.push({
                name: chosen.name,
                overlappingWith: overlappingSkill,
                overlap: Math.round(maxOverlap * 100) / 100
            });
            continue;
        }

        selectedSkills.push(chosen);
        currentTokens += chosen.tokens;
    }

    let totalPairwiseSim = 0;
    let pairsCount = 0;
    for (let i = 0; i < selectedSkills.length; i++) {
        for (let j = i + 1; j < selectedSkills.length; j++) {
            totalPairwiseSim += similarityFn(selectedSkills[i].fullSkillText, selectedSkills[j].fullSkillText);
            pairsCount++;
        }
    }
    const avgOverlap = pairsCount > 0 ? totalPairwiseSim / pairsCount : 0.0;
    const diversityScore = Math.round((1.0 - avgOverlap) * 100) / 100;

    return {
        selectedSkills: selectedSkills.map(({ fullSkillText, ...rest }) => rest),
        totalTokens: currentTokens,
        diversityScore,
        rejectedOverlap
    };
}

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
