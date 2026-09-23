import dotenv from 'dotenv';
import { chat } from './llm.js';
import { searchMemory } from './memory-engine.js';
import { nuggetNudges } from './nuggets-engine.js';
import { getEmbedding } from './embedding-helper.js';
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { getProjectDb } from './sqlite-engine.js';
import { pool } from '../db/pool.js';
import { detectCurrentProject } from './project-helper.js';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

/**
 * Record developer feedback on an auditor nudge.
 * Feedback adjusts rule weights to prevent repeated false positives.
 */
export async function recordNudgeFeedback({ rule_id, feedback, project }) {
    if (!rule_id || !feedback) {
        throw new McpError(ErrorCode.InvalidParams, "Missing rule_id or feedback");
    }
    const targetProject = project || detectCurrentProject();
    let weightDelta = 0.0;
    if (feedback === 'helpful') weightDelta = 0.2;
    else if (feedback === 'unhelpful') weightDelta = -0.3;
    else if (feedback === 'false_positive') weightDelta = -0.6;

    // Record in SQLite
    if (targetProject) {
        try {
            const db = await getProjectDb(targetProject);
            if (db) {
                const existing = db.prepare(`SELECT weight FROM auditor_feedback WHERE rule_id = ?`).get(String(rule_id));
                const newWeight = existing ? Math.max(0.0, existing.weight + weightDelta) : Math.max(0.0, 1.0 + weightDelta);
                db.prepare(`
                    INSERT INTO auditor_feedback (project, rule_id, feedback, weight)
                    VALUES (?, ?, ?, ?)
                `).run(targetProject, String(rule_id), feedback, newWeight);
            }
        } catch (e) {
            console.warn(`[proactive-engine] SQLite feedback warning: ${e.message}`);
        }
    }

    return {
        content: [{
            type: "text",
            text: `[krusch-context] ✅ Recorded '${feedback}' feedback for rule #${rule_id}. Weight updated.`
        }]
    };
}

/**
 * Get active rule weights for a project.
 */
async function getRuleWeights(project) {
    const weights = new Map();
    if (!project) return weights;
    try {
        const db = await getProjectDb(project);
        if (db) {
            const rows = db.prepare(`SELECT rule_id, weight FROM auditor_feedback WHERE project = ? ORDER BY id DESC`).all(project);
            for (const r of rows) {
                if (!weights.has(r.rule_id)) {
                    weights.set(r.rule_id, r.weight);
                }
            }
        }
    } catch {}
    return weights;
}

/**
 * Lightweight, focused invariant auditor.
 * Checks proposed diffs or actions against active project invariants and blockers.
 * Capped to 1-3 findings with concrete evidence.
 */
export async function handleProactiveNudge({
    action = 'audit',
    history,
    code,
    file_path,
    hook,
    trigger = 'manual',
    rule_id,
    feedback,
    project
}) {
    const targetProject = project || detectCurrentProject();
    const effectiveTrigger = (trigger || hook || 'manual').toLowerCase();

    // 1. If action is feedback, record and return
    if (action === 'feedback' || (rule_id && feedback)) {
        return await recordNudgeFeedback({ rule_id, feedback, project: targetProject });
    }

    // 2. Reject/no-op on every_turn to avoid tool call explosion & audit fatigue
    if (effectiveTrigger === 'every_turn') {
        return { 
            content: [{ 
                type: "text", 
                text: "NO_NUDGES_REQUIRED (auditing disabled on every_turn to avoid spam; run on pre_commit or manual)" 
            }] 
        };
    }

    // 2. Parse candidate text to audit
    let queryText = code || "";
    if (!queryText && history) {
        if (Array.isArray(history)) {
            const lastUser = history.slice().reverse().find(m => m.role === 'user');
            queryText = lastUser ? (typeof lastUser.content === 'string' ? lastUser.content : JSON.stringify(lastUser.content)) : "";
        } else if (typeof history === 'string') {
            queryText = history;
        }
    }

    if (!queryText.trim()) {
        return { content: [{ type: "text", text: "NO_NUDGES_REQUIRED" }] };
    }

    // 3. Retrieve active project invariants & blockers
    const ruleWeights = await getRuleWeights(targetProject);
    const candidateRules = [];

    if (targetProject) {
        try {
            const db = await getProjectDb(targetProject);
            if (db) {
                const rows = db.prepare(`
                    SELECT id, category, content
                    FROM ide_agent_memory
                    WHERE status = 'ACTIVE' AND category IN ('invariant', 'blocker', 'bug')
                `).all();

                for (const r of rows) {
                    const weight = ruleWeights.has(String(r.id)) ? ruleWeights.get(String(r.id)) : 1.0;
                    if (weight > 0.2) {
                        candidateRules.push({ id: r.id, category: r.category, content: r.content, weight });
                    }
                }

                // Add active nuggets
                const nugs = db.prepare(`SELECT key, value FROM ide_agent_nuggets`).all();
                for (const n of nugs) {
                    const weight = ruleWeights.has(n.key) ? ruleWeights.get(n.key) : 1.0;
                    if (weight > 0.2) {
                        candidateRules.push({ id: n.key, category: 'nugget', content: `${n.key}: ${n.value}`, weight });
                    }
                }
            }
        } catch (e) {
            console.warn(`[proactive-engine] SQLite rules query error: ${e.message}`);
        }
    }

    if (candidateRules.length === 0) {
        return { content: [{ type: "text", text: "NO_NUDGES_REQUIRED" }] };
    }

    // 4. Quick keyword/heuristic check to filter down relevant rules
    const activeViolations = [];
    const lowerQuery = queryText.toLowerCase();

    for (const rule of candidateRules) {
        // Extract key terms (words > 4 chars) from rule content
        const words = rule.content.toLowerCase().split(/\W+/).filter(w => w.length > 4 && !['should', 'always', 'never', 'before', 'after'].includes(w));
        const matchedWord = words.find(w => lowerQuery.includes(w));
        if (matchedWord) {
            activeViolations.push(rule);
        }
        if (activeViolations.length >= 3) break;
    }

    if (activeViolations.length === 0) {
        return { content: [{ type: "text", text: "NO_NUDGES_REQUIRED" }] };
    }

    // 5. Format concise Markdown findings (capped to 1-3)
    let output = `### 🛡️ Invariant Check (${file_path || hook})\n\n`;
    output += `Found ${activeViolations.length} relevant active invariant(s) for this action:\n\n`;

    for (const v of activeViolations) {
        output += `* **Rule #${v.id}** [${v.category}]: ${v.content}\n`;
    }
    output += `\n*If this nudge is unhelpful or a false positive, call 'nudge' with action: 'feedback', rule_id: '<id>', feedback: 'false_positive'.*`;

    return {
        content: [{ type: "text", text: output }]
    };
}
