import { pool } from 'pg-git/db/pool.js';
import { getEmbedding } from 'pg-git/lib/embedding.js';
import { config } from 'pg-git/config.js';
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

const DECAY_RATE = 0.01;
const AUTO_TAG = true; // Hardcoded for context MCP

/** Resolve the best Ollama generate endpoint from pg-git config or env. */
function getOllamaGenerateUrl() {
    const base = process.env.OLLAMA_URL || config.ai?.ollamaUrl || 'http://localhost:11434';
    return `${base.replace(/\/$/, '')}/api/generate`;
}

async function generateTags(text) {
    try {
        const res = await fetch(getOllamaGenerateUrl(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: "llama3.2",
                prompt: `Extract 3 to 5 concise keywords or tags from the following text. Respond ONLY with a comma-separated list of tags, nothing else.\n\nText: "${text}"`,
                stream: false
            })
        });
        
        if (!res.ok) return null;
        
        const data = await res.json();
        const tags = data.response.split(',').map(t => t.trim()).filter(t => t.length > 0);
        return JSON.stringify(tags);
    } catch (err) {
        console.error(`[krusch-context] Warning: Tag generation failed: ${err.message}`);
        return null;
    }
}

export async function addMemory({ category, content, tags, project, _embedding }) {
    if (!category || !content) throw new McpError(ErrorCode.InvalidParams, "Missing params");
    
    const embeddingArray = _embedding || await getEmbedding(content);
    if (!embeddingArray) throw new McpError(ErrorCode.InternalError, "Failed to generate embedding");

    let finalTags = tags ? JSON.stringify(tags) : null;
    if (!finalTags && AUTO_TAG) {
        finalTags = await generateTags(content);
    }

    const client = await pool.connect();
    try {
        const embeddingStr = `[${embeddingArray.join(',')}]`;
        await client.query(`
            INSERT INTO ide_agent_memory (project, category, content, embedding, tags)
            VALUES ($1, $2, $3, $4::vector, $5)
        `, [project || null, category, content, embeddingStr, finalTags]);
    } finally {
        client.release();
    }
    
    return { content: [{ type: "text", text: `[krusch-context] ✅ Successfully saved memory to category: ${category}` }] };
}

export async function searchMemory({ category, query, limit = 3, active_project, _embedding }) {
    if (!category || !query) throw new McpError(ErrorCode.InvalidParams, "Missing params");

    const embeddingArray = _embedding || await getEmbedding(query);
    if (!embeddingArray) throw new McpError(ErrorCode.InternalError, "Failed to generate embedding");

    const client = await pool.connect();
    let results = [];
    try {
        const embeddingStr = `[${embeddingArray.join(',')}]`;
        const res = await client.query(`
            WITH semantic_matches AS (
                SELECT id, project, content, tags, created_at, embedding <=> $1::vector as distance
                FROM ide_agent_memory
                WHERE category = $2
                ORDER BY embedding <=> $1::vector
                LIMIT 100
            )
            SELECT 
                id,
                project,
                content, 
                tags, 
                created_at,
                ((1 - distance) + CASE WHEN project = $5 THEN 0.1 ELSE 0 END) * exp(-$4::float * EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - created_at))/86400) as similarity
            FROM semantic_matches
            ORDER BY similarity DESC
            LIMIT $3
        `, [embeddingStr, category, limit, DECAY_RATE, active_project || null]);
        results = res.rows;
    } finally {
        client.release();
    }

    if (results.length === 0) {
        return { content: [{ type: "text", text: `=== 🧠 Memory Retrieval: ${category} ===\n\nNo results found.` }] };
    }

    let output = `=== 🧠 Memory Retrieval: ${category} ===\n`;
    for (const r of results) {
        let tagsStr = '';
        if (r.tags) {
            try { tagsStr = ` [Tags: ${JSON.parse(r.tags).join(', ')}]`; } catch(e) {}
        }
        const dateStr = r.created_at ? new Date(r.created_at).toISOString().split('T')[0] : 'unknown';
        const projectStr = r.project ? ` | Project: ${r.project}` : '';
        output += `\n--- Match (Score: ${Number(r.similarity).toFixed(2)}) | ID: ${r.id} | Date: ${dateStr}${projectStr}${tagsStr} ---\n${r.content}\n`;
    }
    return { content: [{ type: "text", text: output }] };
}

export async function listMemories({ category, project, limit = 10 }) {
    if (!category) throw new McpError(ErrorCode.InvalidParams, "Missing category");

    const client = await pool.connect();
    let results = [];
    try {
        let sql = `SELECT id, project, content, tags, created_at FROM ide_agent_memory WHERE category = $1`;
        const params = [category];
        if (project) {
            sql += ` AND project = $2`;
            params.push(project);
        }
        sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
        params.push(limit);
        const res = await client.query(sql, params);
        results = res.rows;
    } finally {
        client.release();
    }

    if (results.length === 0) {
        return { content: [{ type: "text", text: `=== 📋 Memory List: ${category} ===\n\nNo memories found.` }] };
    }

    let output = `=== 📋 Memory List: ${category} (${results.length} results) ===\n`;
    for (const r of results) {
        let tagsStr = '';
        if (r.tags) {
            try { tagsStr = ` [Tags: ${JSON.parse(r.tags).join(', ')}]`; } catch(e) {}
        }
        const dateStr = r.created_at ? new Date(r.created_at).toISOString().split('T')[0] : 'unknown';
        const projectStr = r.project ? ` | Project: ${r.project}` : '';
        output += `\n--- ID: ${r.id} | Date: ${dateStr}${projectStr}${tagsStr} ---\n${r.content}\n`;
    }
    return { content: [{ type: "text", text: output }] };
}

export async function deleteMemory({ id }) {
    if (!id) throw new McpError(ErrorCode.InvalidParams, "Missing memory ID");

    const client = await pool.connect();
    try {
        const res = await client.query(`DELETE FROM ide_agent_memory WHERE id = $1 RETURNING id`, [id]);
        if (res.rowCount === 0) {
            return { content: [{ type: "text", text: `[krusch-context] ⚠️ No memory found with ID: ${id}` }] };
        }
    } finally {
        client.release();
    }
    return { content: [{ type: "text", text: `[krusch-context] 🗑️ Deleted memory ID: ${id}` }] };
}

export async function updateMemory({ id, content, tags, project }) {
    if (!id) throw new McpError(ErrorCode.InvalidParams, "Missing memory ID");
    if (!content && !tags && (project === undefined)) {
        throw new McpError(ErrorCode.InvalidParams, "Must provide at least one field to update (content, tags, or project)");
    }

    const client = await pool.connect();
    try {
        const setClauses = [];
        const params = [];
        let idx = 1;

        if (content) {
            // Re-embed when content changes
            const embeddingArray = await getEmbedding(content);
            if (!embeddingArray) throw new McpError(ErrorCode.InternalError, "Failed to generate embedding");
            const embeddingStr = `[${embeddingArray.join(',')}]`;
            setClauses.push(`content = $${idx++}`);
            params.push(content);
            setClauses.push(`embedding = $${idx++}::vector`);
            params.push(embeddingStr);
        }
        if (tags) {
            setClauses.push(`tags = $${idx++}`);
            params.push(JSON.stringify(tags));
        }
        if (project !== undefined) {
            setClauses.push(`project = $${idx++}`);
            params.push(project || null);
        }

        params.push(id);
        const res = await client.query(
            `UPDATE ide_agent_memory SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING id`,
            params
        );
        if (res.rowCount === 0) {
            return { content: [{ type: "text", text: `[krusch-context] ⚠️ No memory found with ID: ${id}` }] };
        }
    } finally {
        client.release();
    }
    return { content: [{ type: "text", text: `[krusch-context] ✏️ Updated memory ID: ${id}` }] };
}

/**
 * Find and merge semantically duplicate memories within a category.
 * Uses cosine distance to find pairs closer than the threshold,
 * then merges content and deletes the older record.
 */
export async function consolidateMemories({ category, project, threshold = 0.15, dry_run = false }) {
    if (!category) throw new McpError(ErrorCode.InvalidParams, "Missing category");

    const client = await pool.connect();
    try {
        // Find pairs of memories whose embeddings are very close (distance < threshold)
        let sql = `
            WITH candidates AS (
                SELECT id, content, tags, project, created_at, embedding
                FROM ide_agent_memory
                WHERE category = $1 AND embedding IS NOT NULL
        `;
        const params = [category];
        if (project) {
            sql += ` AND project = $2`;
            params.push(project);
        }
        sql += `
            )
            SELECT 
                a.id AS id_a, a.content AS content_a, a.created_at AS created_a,
                b.id AS id_b, b.content AS content_b, b.created_at AS created_b,
                a.embedding <=> b.embedding AS distance
            FROM candidates a
            JOIN candidates b ON a.id < b.id
            WHERE a.embedding <=> b.embedding < $${params.length + 1}
            ORDER BY distance ASC
            LIMIT 20
        `;
        params.push(threshold);

        const res = await client.query(sql, params);
        const pairs = res.rows;

        if (pairs.length === 0) {
            return { content: [{ type: "text", text: `[krusch-context] ✅ No duplicate memories found in category: ${category} (threshold: ${threshold})` }] };
        }

        if (dry_run) {
            let output = `=== 🔍 Consolidation Preview: ${category} (${pairs.length} pairs) ===\n`;
            for (const p of pairs) {
                output += `\n--- Distance: ${Number(p.distance).toFixed(3)} ---\n`;
                output += `  ID ${p.id_a} (${new Date(p.created_a).toISOString().split('T')[0]}): ${p.content_a.substring(0, 100)}...\n`;
                output += `  ID ${p.id_b} (${new Date(p.created_b).toISOString().split('T')[0]}): ${p.content_b.substring(0, 100)}...\n`;
            }
            return { content: [{ type: "text", text: output }] };
        }

        // Merge: keep the newer record, append older content, delete the older one
        const merged = new Set();
        let mergeCount = 0;
        for (const p of pairs) {
            if (merged.has(p.id_a) || merged.has(p.id_b)) continue;

            const keepId = p.created_a > p.created_b ? p.id_a : p.id_b;
            const dropId = keepId === p.id_a ? p.id_b : p.id_a;
            const keepContent = keepId === p.id_a ? p.content_a : p.content_b;
            const dropContent = keepId === p.id_a ? p.content_b : p.content_a;

            const mergedContent = `${keepContent}\n\n[Consolidated from ID ${dropId}]: ${dropContent}`;

            // Re-embed the merged content
            const embeddingArray = await getEmbedding(mergedContent);
            if (embeddingArray) {
                const embeddingStr = `[${embeddingArray.join(',')}]`;
                await client.query(
                    `UPDATE ide_agent_memory SET content = $1, embedding = $2::vector WHERE id = $3`,
                    [mergedContent, embeddingStr, keepId]
                );
                await client.query(`DELETE FROM ide_agent_memory WHERE id = $1`, [dropId]);
                merged.add(dropId);
                mergeCount++;
            }
        }

        return { content: [{ type: "text", text: `[krusch-context] 🔗 Consolidated ${mergeCount} duplicate pairs in category: ${category}` }] };
    } finally {
        client.release();
    }
}
