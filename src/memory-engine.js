/**
 * @module memory-engine
 * Universal Memory & Steering Engine for AI Agents.
 * Implements:
 * 1. Safe episodic memory CRUD with strict closed taxonomy
 * 2. Temporal superseding with lineage tracking
 * 3. Explicit invalidation requiring mandatory reason
 * 4. Near-duplicate detection (threshold 0.85) proposing supersede
 * 5. Full provenance recording (author, file, commit, pr, confidence)
 * 6. 30-day TTL decay review
 */

import { pool } from '../db/pool.js';
import { getEmbedding } from './embedding-helper.js';
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { getProjectDb, cosineSimilarity, pushProjectMemory } from './sqlite-engine.js';
import { checkNearDuplicateMemory, getStorageMode } from './storage-adapter.js';
import { generateTagsFromLLM } from './llm-tags.js';
import { isPgContextEnabled, syncPgContextPoints } from './pgcontext-helper.js';
import { detectCurrentProject, getWorktreeStatus } from './project-helper.js';

export const CLOSED_CATEGORIES = new Set(['decision', 'bug', 'invariant', 'lesson', 'blocker']);
const DECAY_RATE = 0.01;
const AUTO_TAG = true;

/**
 * Normalizes user-supplied category to the strict closed set.
 */
export function normalizeCategory(category) {
    if (!category) return 'lesson';
    const lower = category.toLowerCase().trim();
    if (CLOSED_CATEGORIES.has(lower)) return lower;
    
    // Map legacy terms gracefully
    if (lower === 'priorities' || lower === 'priority') return 'decision';
    if (lower === 'outcomes' || lower === 'outcome') return 'lesson';
    if (lower === 'activity' || lower === 'activities') return 'lesson';
    if (lower === 'lessons') return 'lesson';
    if (lower === 'bugs') return 'bug';
    if (lower === 'invariants') return 'invariant';
    if (lower === 'blockers') return 'blocker';
    if (lower === 'decisions') return 'decision';

    throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid category '${category}'. Permitted closed set: ${[...CLOSED_CATEGORIES].join(', ')}.`
    );
}

/**
 * Filter memories to return only active, non-superseded, non-invalidated records.
 */
export function filterActiveMemories(memories = []) {
    if (!Array.isArray(memories)) return [];
    return memories.filter(m => m.status === 'ACTIVE' || (!m.status && !m.superseded_by && !m.supersedes_id));
}

/**
 * Adds or remembers a memory with duplicate check and provenance.
 */
export async function addMemory({
    category,
    content,
    tags,
    project,
    active_project,
    supersedes_id,
    provenance,
    force = false,
    _embedding
}) {
    if (!content || typeof content !== 'string' || !content.trim()) {
        throw new McpError(ErrorCode.InvalidParams, "Parameter 'content' must be non-empty text");
    }

    const normCat = normalizeCategory(category);
    const targetProject = project || active_project || detectCurrentProject();
    
    // 1. Compute embedding
    const embeddingArray = _embedding || await getEmbedding(content);
    if (!embeddingArray) {
        throw new McpError(ErrorCode.InternalError, "Failed to generate embedding");
    }

    // 2. Near-duplicate detection (non-blocking: proposes revise with candidate id & cosine, does not reject write)
    let nearDup = null;
    if (!force && !supersedes_id) {
        nearDup = await checkNearDuplicateMemory({
            project: targetProject,
            category: normCat,
            embedding: embeddingArray,
            threshold: 0.85
        });
    }

    // 3. Process tags
    let finalTags = tags ? JSON.stringify(tags) : null;
    if (!finalTags && AUTO_TAG) {
        finalTags = await generateTagsFromLLM(content, { asJson: true });
    }

    // 4. Provenance
    const provPayload = provenance ? JSON.stringify({
        file: provenance.file || null,
        commit: provenance.commit || null,
        pr: provenance.pr || null,
        author: provenance.author || 'agent',
        confidence: provenance.confidence ?? 1.0,
        recorded_at: new Date().toISOString()
    }) : JSON.stringify({ author: 'agent', confidence: 1.0, recorded_at: new Date().toISOString() });

    const embeddingStr = `[${embeddingArray.join(',')}]`;

    // 5. Insert into SQLite project DB
    const db = await getProjectDb(targetProject);
    if (db) {
        const info = db.prepare(`
            INSERT INTO ide_agent_memory (category, content, tags, embedding, status, supersedes_id, provenance)
            VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?)
        `).run(normCat, content, finalTags, embeddingStr, supersedes_id || null, provPayload);

        const newId = info.lastInsertRowid;
        if (supersedes_id) {
            try {
                db.prepare(`UPDATE ide_agent_memory SET status = 'SUPERSEDED', superseded_by = ? WHERE id = ?`).run(newId, supersedes_id);
            } catch (err) {
                console.warn(`[memory-engine] SQLite supersede update warning: ${err.message}`);
            }
        }

        // Push behind if postgres available
        pushProjectMemory(targetProject, db).catch(() => {});

        const supersedeNote = supersedes_id ? ` (supersedes ID ${supersedes_id})` : '';
        const nearDupNote = nearDup 
            ? `\n\n⚠️ Near-duplicate memory detected (${(nearDup.similarity * 100).toFixed(1)}% match with Memory #${nearDup.id} [${nearDup.category}]: "${nearDup.content}").\n` +
              `If this memory supersedes or contradicts #${nearDup.id}, call 'revise' with action: 'supersede', target_id: ${nearDup.id}.`
            : '';

        const response = {
            content: [{
                type: "text",
                text: `[krusch-context] ✅ Successfully saved memory to SQLite project DB: ${targetProject} (${normCat}) #${newId}${supersedeNote}${nearDupNote}`
            }],
            id: newId
        };

        if (nearDup) {
            response.warning = 'near_duplicate';
            response.candidate_id = nearDup.id;
            response.candidate_content = nearDup.content;
            response.similarity = nearDup.similarity;
            response.suggested_action = {
                tool: 'krusch_context_revise',
                action: 'supersede',
                target_id: nearDup.id
            };
        }

        return response;
    }

    throw new McpError(ErrorCode.InternalError, "Failed to access local database");
}


/**
 * Supersedes an outdated memory with updated knowledge.
 */
export async function supersedeMemory({ id, category, content, project, active_project, tags, provenance }) {
    if (!id) throw new McpError(ErrorCode.InvalidParams, "Missing parameter 'id'");
    if (!content) throw new McpError(ErrorCode.InvalidParams, "Missing parameter 'content'");
    return await addMemory({
        category,
        content,
        tags,
        project: project || active_project,
        supersedes_id: id,
        provenance,
        force: true
    });
}

/**
 * Explicitly invalidates a memory with a mandatory reason.
 */
export async function invalidateMemory({ id, reason, project, active_project }) {
    if (!id) throw new McpError(ErrorCode.InvalidParams, "Missing parameter 'id'");
    if (!reason || typeof reason !== 'string' || !reason.trim()) {
        throw new McpError(
            ErrorCode.InvalidParams,
            "Invalidation requires a non-empty 'reason' describing why this memory is obsolete/deprecated."
        );
    }

    const targetProject = project || active_project || detectCurrentProject();
    const db = await getProjectDb(targetProject);
    if (db) {
        db.prepare(`
            UPDATE ide_agent_memory 
            SET status = 'INVALIDATED', invalidated_reason = ? 
            WHERE id = ?
        `).run(reason.trim(), id);

        return {
            content: [{
                type: "text",
                text: `[krusch-context] 🗑️ Memory #${id} marked as INVALIDATED.\nReason: "${reason.trim()}"`
            }]
        };
    }

    throw new McpError(ErrorCode.InternalError, "Failed to access local database");
}

/**
 * Searches memories using semantic and keyword matching.
 */
export async function searchMemory({
    category,
    query,
    limit = 5,
    project,
    active_project,
    include_superseded = false,
    _embedding
}) {
    if (!query) throw new McpError(ErrorCode.InvalidParams, "Missing parameter 'query'");
    const targetProject = project || active_project || detectCurrentProject();
    const normCat = category ? normalizeCategory(category) : null;

    const db = await getProjectDb(targetProject);
    if (!db) return { content: [{ type: "text", text: "No memories found (database unavailable)." }] };

    let sql = `SELECT id, category, content, tags, status, supersedes_id, superseded_by, created_at, embedding FROM ide_agent_memory`;
    const conditions = [];
    const params = [];

    if (!include_superseded) {
        conditions.push(`status = 'ACTIVE'`);
    }
    if (normCat) {
        conditions.push(`category = ?`);
        params.push(normCat);
    }
    if (conditions.length > 0) {
        sql += ` WHERE ` + conditions.join(' AND ');
    }
    sql += ` ORDER BY created_at DESC`;

    const rows = db.prepare(sql).all(...params);
    const embeddingArray = _embedding || await getEmbedding(query);

    const scored = rows.map(r => {
        let score = 0.5;
        if (embeddingArray && r.embedding) {
            try {
                const vec = typeof r.embedding === 'string' ? JSON.parse(r.embedding) : r.embedding;
                score = cosineSimilarity(embeddingArray, vec);
            } catch {}
        }
        if (r.content.toLowerCase().includes(query.toLowerCase())) {
            score = Math.max(score, 0.8);
        }
        return { ...r, score };
    }).sort((a, b) => b.score - a.score).slice(0, limit);

    if (scored.length === 0) {
        return { content: [{ type: "text", text: `=== 🧠 Memory Retrieval: "${query}" (0 results) ===\n\nNo memories found matching "${query}".` }] };
    }


    let output = `=== 🧠 Memory Retrieval: "${query}" (${scored.length} results) ===\n\n`;
    for (const s of scored) {
        const badge = s.status === 'SUPERSEDED' ? ' [SUPERSEDED]' : '';
        output += `* **#${s.id}** [${s.category}]${badge} (Score: ${(s.score * 100).toFixed(1)}%): ${s.content}\n`;
    }

    return { content: [{ type: "text", text: output }] };

}

/**
 * Returns memories unreferenced or older than 30 days for decay review.
 */
export async function getStaleMemories({ project, days = 30 } = {}) {
    const targetProject = project || detectCurrentProject();
    const db = await getProjectDb(targetProject);
    if (!db) return [];

    const rows = db.prepare(`
        SELECT id, category, content, created_at
        FROM ide_agent_memory
        WHERE status = 'ACTIVE'
          AND created_at < datetime('now', '-' || ? || ' days')
        ORDER BY created_at ASC
        LIMIT 10
    `).all(days);

    return rows;
}

/**
 * Compiles a consolidated project state briefing.
 */
export async function compileProjectState({ project, active_project } = {}) {
    const targetProject = project || active_project || detectCurrentProject();
    const db = await getProjectDb(targetProject);

    const decisions = [];
    const invariants = [];
    const bugs = [];
    const lessons = [];
    const nuggets = [];
    const invalidated = [];

    if (db) {
        const rows = db.prepare(`
            SELECT id, category, content, status, invalidated_reason, created_at
            FROM ide_agent_memory
            ORDER BY created_at DESC
        `).all();

        for (const r of rows) {
            if (r.status === 'INVALIDATED') {
                if (invalidated.length < 5) invalidated.push(r);
                continue;
            }
            if (r.status !== 'ACTIVE') continue;

            if (r.category === 'decision') decisions.push(r);
            else if (r.category === 'invariant') invariants.push(r);
            else if (r.category === 'bug' || r.category === 'blocker') bugs.push(r);
            else lessons.push(r);
        }

        const nugRows = db.prepare(`SELECT key, value, kind FROM ide_agent_nuggets`).all();
        nuggets.push(...nugRows);
    }

    const stale = await getStaleMemories({ project: targetProject, days: 30 });

    let output = `# 🧠 Compiled Project State: ${targetProject}\n\n`;

    output += `## 🎯 Decisions & Priorities (${decisions.length})\n`;
    if (decisions.length === 0) output += `- No active decisions or priorities recorded.\n`;
    for (const d of decisions.slice(0, 5)) output += `- **#${d.id}**: ${d.content}\n`;
    output += `\n`;


    output += `## 🛡️ Project Invariants (${invariants.length})\n`;
    if (invariants.length === 0) output += `- No invariants recorded.\n`;
    for (const inv of invariants.slice(0, 5)) output += `- **#${inv.id}**: ${inv.content}\n`;
    output += `\n`;

    output += `## 🐛 Known Bugs & Blockers (${bugs.length})\n`;
    if (bugs.length === 0) output += `- Zero active blockers.\n`;
    for (const b of bugs.slice(0, 5)) output += `- **#${b.id}** [${b.category}]: ${b.content}\n`;
    output += `\n`;

    output += `## 📖 Core Lessons (${lessons.length})\n`;
    if (lessons.length === 0) output += `- No lessons recorded yet.\n`;
    for (const l of lessons.slice(0, 5)) output += `- **#${l.id}**: ${l.content}\n`;
    output += `\n`;

    if (nuggets.length > 0) {
        output += `## ⚡ Steering Nuggets (${nuggets.length})\n`;
        for (const n of nuggets) output += `- **${n.key}**: ${n.value}\n`;
        output += `\n`;
    }

    if (invalidated.length > 0) {
        output += `## 🚫 Recently Invalidated Rules (${invalidated.length})\n`;
        for (const inv of invalidated) {
            output += `- ~~#${inv.id} (${inv.category})~~ — *Revocation Reason*: ${inv.invalidated_reason || 'Deprecated'}\n`;
        }
        output += `\n`;
    }

    if (stale.length > 0) {
        output += `## ⏳ Decay Review (${stale.length} items >30 days old)\n`;
        for (const s of stale) {
            output += `- Memory #${s.id} [${s.category}]: "${s.content.substring(0, 80)}..." (Review if still valid)\n`;
        }
        output += `\n`;
    }

    return { content: [{ type: "text", text: output }] };
}

/**
 * Returns health diagnostic statistics.
 */
export async function getHealthStats({ project } = {}) {
    const targetProject = project || detectCurrentProject();
    const mode = getStorageMode();
    const db = await getProjectDb(targetProject);

    let activeCount = 0;
    let supersededCount = 0;
    let invalidatedCount = 0;
    let nuggetCount = 0;
    const categoryCounts = {};

    if (db) {
        const memRows = db.prepare(`SELECT category, status FROM ide_agent_memory`).all();
        for (const r of memRows) {
            if (r.status === 'ACTIVE') {
                activeCount++;
                categoryCounts[r.category] = (categoryCounts[r.category] || 0) + 1;
            } else if (r.status === 'SUPERSEDED') {
                supersededCount++;
            } else if (r.status === 'INVALIDATED') {
                invalidatedCount++;
            }
        }
        const nugRow = db.prepare(`SELECT count(*) as count FROM ide_agent_nuggets`).get();
        nuggetCount = nugRow ? nugRow.count : 0;
    }

    const stale = await getStaleMemories({ project: targetProject, days: 30 });
    const worktree = getWorktreeStatus();

    let output = `# 🩺 Krusch Context Health Status\n\n`;
    output += `* **Storage Mode**: \`${mode}\` (${mode === 'sqlite' ? '.agent/context.db' : 'PostgreSQL'})\n`;
    output += `* **Active Project**: \`${targetProject}\`\n`;
    output += `* **Worktree Dirty**: ${worktree.isDirty ? `⚠️ Yes (${worktree.modifiedCount} uncommitted files)` : `✅ Clean`}\n`;
    output += `* **Active Memories**: ${activeCount}\n`;
    for (const cat of CLOSED_CATEGORIES) {
        output += `  - ${cat}: ${categoryCounts[cat] || 0}\n`;
    }
    output += `* **Superseded Lineage**: ${supersededCount}\n`;
    output += `* **Invalidated Records**: ${invalidatedCount}\n`;
    output += `* **Steering Nuggets**: ${nuggetCount}\n`;
    if (stale.length > 0) {
        output += `* **Decay Review**: ⏳ ${stale.length} memories have not been referenced in >30 days.\n`;
    } else {
        output += `* **Decay Review**: ✅ All active memories fresh (<30 days).\n`;
    }

    return {
        content: [{ type: "text", text: output }],
        stats: {
            storageMode: mode,
            project: targetProject,
            activeCount,
            supersededCount,
            invalidatedCount,
            nuggetCount,
            staleCount: stale.length
        }
    };
}

/**
 * Lists memories chronologically (Admin tool for extended profile).
 */
export async function listMemories({ category, project, active_project, limit = 10 } = {}) {
    const targetProject = project || active_project || detectCurrentProject();
    const db = await getProjectDb(targetProject);
    if (!db) return { content: [{ type: "text", text: "Database not available." }] };

    let sql = `SELECT id, category, content, tags, status, created_at FROM ide_agent_memory`;
    const params = [];
    if (category) {
        sql += ` WHERE category = ?`;
        params.push(normalizeCategory(category));
    }
    sql += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);

    const rows = db.prepare(sql).all(...params);
    if (rows.length === 0) {
        return { content: [{ type: "text", text: `No memories found${category ? ` in category ${category}` : ''}.` }] };
    }

    let output = `=== 📋 Memory List (${rows.length} records) ===\n\n`;
    for (const r of rows) {
        output += `* **#${r.id}** [${r.category}] (${r.status}): ${r.content}\n`;
    }
    return { content: [{ type: "text", text: output }] };
}

/**
 * Hard-deletes a memory record (Admin tool for extended profile).
 */
export async function deleteMemory({ id, project, active_project } = {}) {
    if (!id) throw new McpError(ErrorCode.InvalidParams, "Missing parameter 'id'");
    const targetProject = project || active_project || detectCurrentProject();
    const db = await getProjectDb(targetProject);
    if (db) {
        db.prepare(`DELETE FROM ide_agent_memory WHERE id = ?`).run(id);
        return { content: [{ type: "text", text: `[krusch-context] 🗑️ Deleted memory record #${id}` }] };
    }
    throw new McpError(ErrorCode.InternalError, "Database unavailable");
}

/**
 * Updates a memory record's content and tags (Admin tool for extended profile).
 */
export async function updateMemory({ id, content, tags, project, active_project } = {}) {
    if (!id || !content) throw new McpError(ErrorCode.InvalidParams, "Missing id or content");
    const targetProject = project || active_project || detectCurrentProject();
    const db = await getProjectDb(targetProject);
    if (db) {
        const emb = await getEmbedding(content);
        const embStr = emb ? `[${emb.join(',')}]` : null;
        const tagStr = tags ? JSON.stringify(tags) : null;
        db.prepare(`UPDATE ide_agent_memory SET content = ?, tags = ?, embedding = ? WHERE id = ?`).run(content, tagStr, embStr, id);
        return { content: [{ type: "text", text: `[krusch-context] ✅ Updated memory record #${id}` }] };
    }
    throw new McpError(ErrorCode.InternalError, "Database unavailable");
}

/**
 * Consolidates duplicate memories within a category (Admin tool for extended profile).
 */
export async function consolidateMemories({ category, project, active_project, threshold = 0.15, dry_run = false } = {}) {
    if (!category) throw new McpError(ErrorCode.InvalidParams, "Missing category");
    const targetProject = project || active_project || detectCurrentProject();
    const normCat = normalizeCategory(category);
    const db = await getProjectDb(targetProject);
    if (!db) return { content: [{ type: "text", text: "Database unavailable" }] };

    const rows = db.prepare(`SELECT id, content, embedding FROM ide_agent_memory WHERE category = ? AND status = 'ACTIVE'`).all(normCat);
    const pairs = [];

    for (let i = 0; i < rows.length; i++) {
        for (let j = i + 1; j < rows.length; j++) {
            if (!rows[i].embedding || !rows[j].embedding) continue;
            try {
                const vecA = JSON.parse(rows[i].embedding);
                const vecB = JSON.parse(rows[j].embedding);
                const sim = cosineSimilarity(vecA, vecB);
                const dist = 1 - sim;
                if (dist <= threshold) {
                    pairs.push({ a: rows[i], b: rows[j], dist });
                }
            } catch {}
        }
    }

    if (pairs.length === 0) {
        return { content: [{ type: "text", text: `✅ No duplicate memories found in category '${normCat}' (threshold: ${threshold})` }] };
    }

    if (dry_run) {
        let output = `=== 🔍 Consolidation Preview (${pairs.length} duplicate pairs) ===\n\n`;
        for (const p of pairs) {
            output += `* Distance: ${p.dist.toFixed(3)}\n  - #${p.a.id}: "${p.a.content.substring(0, 60)}..."\n  - #${p.b.id}: "${p.b.content.substring(0, 60)}..."\n`;
        }
        return { content: [{ type: "text", text: output }] };
    }

    let mergedCount = 0;
    for (const p of pairs) {
        // Mark the newer one as superseded by the older one
        db.prepare(`UPDATE ide_agent_memory SET status = 'SUPERSEDED', superseded_by = ? WHERE id = ?`).run(p.a.id, p.b.id);
        mergedCount++;
    }

    return { content: [{ type: "text", text: `🔗 Consolidated ${mergedCount} duplicate pairs in category '${normCat}'.` }] };
}

