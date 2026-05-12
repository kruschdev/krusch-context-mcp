/**
 * @module v2-engine
 * Company Brain v2 Substrate — stateful memory with optimistic concurrency,
 * conflict resolution, provenance tracing, lens-based retrieval, and graph traversal.
 *
 * Extracted from memory-engine.js (ARCH/01) to enforce single-responsibility:
 *   - memory-engine.js handles v1 episodic CRUD (add, search, list, delete, update, consolidate)
 *   - v2-engine.js handles stateful Company Brain substrate operations
 */

import { pool } from 'pg-git-mcp/db/pool.js';
import { getEmbedding, ollamaQueue, PRIORITY } from 'pg-git-mcp/lib/embedding.js';
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

const AUTO_TAG = true;

/**
 * Generates semantic ontology tags for memory content using a local LLM.
 * Aligned with the Sentra Interaction/Action memory layers.
 * @param {string} text - The text content to tag.
 * @returns {Promise<string[]|null>} Array of tags or null if failed.
 */
async function generateOntologyTags(text) {
    try {
        return await ollamaQueue.enqueue(async (endpoint) => {
            const url = `${endpoint.replace(/\/$/, '')}/api/generate`;
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: "llama3.2",
                    prompt: `Analyze the following text and extract 3 to 5 concise ontology tags. Choose primarily from these categories if they apply: decision, commitment, objection, escalation, dependency, assumption, customer pain, owner, precedent, open question. You may add other relevant keywords. Respond ONLY with a comma-separated list of tags, nothing else.\n\nText: "${text}"`,
                    stream: false
                })
            });
            
            if (!res.ok) throw new Error(`Status ${res.status}`);
            
            const data = await res.json();
            return data.response.split(',').map(t => t.trim().toLowerCase()).filter(t => t.length > 0);
        }, PRIORITY.MEDIUM);
    } catch (err) {
        console.error(`[krusch-context] Warning: Ontology tag generation failed: ${err.message}`);
        return null;
    }
}

/**
 * Company Brain v2: Write a memory state with optimistic concurrency control.
 * @param {object} params
 * @param {string} params.content - The memory content
 * @param {string} params.category - Memory category
 * @param {string} params.author_id - Identifier of the agent/human
 * @param {string} [params.parent_id] - UUID for optimistic concurrency
 * @param {string} [params.source_ref] - URI or document hash
 * @param {string[]} [params.ontology_tags] - Optional pre-defined tags
 * @returns {Promise<{content: Array}>} MCP tool response
 */
export async function writeState({ content, category, author_id, parent_id, source_ref, ontology_tags, action_trace }) {
    if (!content || !category || !author_id) throw new McpError(ErrorCode.InvalidParams, "Missing required params");

    const embeddingArray = await getEmbedding(content);
    if (!embeddingArray) throw new McpError(ErrorCode.InternalError, "Failed to generate embedding");
    const embeddingStr = `[${embeddingArray.join(',')}]`;

    let finalOntologyTags = ontology_tags;
    if (!finalOntologyTags && AUTO_TAG) {
        finalOntologyTags = await generateOntologyTags(content);
    }
    const tagsStr = finalOntologyTags && finalOntologyTags.length > 0 ? `{${finalOntologyTags.map(t => `"${t}"`).join(',')}}` : null;
    const actionTraceStr = action_trace ? JSON.stringify(action_trace) : null;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        let version_id = 1;
        
        if (parent_id) {
            // Check if parent_id exists and is active
            const parentRes = await client.query('SELECT version_id, status FROM homelab_memory_v2 WHERE id = $1', [parent_id]);
            if (parentRes.rows.length === 0) {
                throw new McpError(ErrorCode.InvalidParams, `Parent ID ${parent_id} not found.`);
            }
            if (parentRes.rows[0].status !== 'active') {
                throw new McpError(ErrorCode.InvalidRequest, `State Conflict: Parent ID ${parent_id} is no longer active (status: ${parentRes.rows[0].status}). Please pull latest state.`);
            }
            version_id = parentRes.rows[0].version_id + 1;
            
            // Mark parent as deprecated
            await client.query("UPDATE homelab_memory_v2 SET status = 'deprecated', updated_at = NOW() WHERE id = $1", [parent_id]);
        }
        
        const insertQuery = `
            INSERT INTO homelab_memory_v2 
            (category, content, embedding, author_id, source_ref, parent_id, version_id, status, ontology_tags, action_trace)
            VALUES ($1, $2, $3::vector, $4, $5, $6, $7, 'active', $8, $9::jsonb)
            RETURNING id
        `;
        const res = await client.query(insertQuery, [
            category, content, embeddingStr, author_id, source_ref || null, parent_id || null, version_id, tagsStr, actionTraceStr
        ]);
        
        await client.query('COMMIT');
        return { content: [{ type: "text", text: `[krusch-context] ✅ State written successfully. New ID: ${res.rows[0].id} (Version ${version_id})` }] };
    } catch (err) {
        await client.query('ROLLBACK');
        throw new McpError(ErrorCode.InternalError, `Database error: ${err.message}`);
    } finally {
        client.release();
    }
}

/**
 * Company Brain v2: Resolve conflicting branching states.
 * @param {object} params
 * @param {string[]} params.conflict_ids - IDs of conflicting sibling states
 * @param {string} params.resolution_content - The merged truth
 * @param {string} params.author_id - Identifier of the resolving agent/human
 * @returns {Promise<{content: Array}>} MCP tool response
 */
export async function resolveConflict({ conflict_ids, resolution_content, author_id }) {
    if (!conflict_ids || conflict_ids.length < 2 || !resolution_content || !author_id) {
        throw new McpError(ErrorCode.InvalidParams, "Missing required params. Need at least 2 conflict_ids.");
    }
    
    const embeddingArray = await getEmbedding(resolution_content);
    if (!embeddingArray) throw new McpError(ErrorCode.InternalError, "Failed to generate embedding");
    const embeddingStr = `[${embeddingArray.join(',')}]`;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // Verify all conflict IDs exist and are active
        const placeholders = conflict_ids.map((_, i) => `$${i + 1}`).join(',');
        const checkRes = await client.query(`SELECT id, status, category FROM homelab_memory_v2 WHERE id IN (${placeholders})`, conflict_ids);
        
        if (checkRes.rows.length !== conflict_ids.length) {
            throw new McpError(ErrorCode.InvalidParams, "One or more conflict_ids not found.");
        }
        
        for (const row of checkRes.rows) {
            if (row.status !== 'active') {
                throw new McpError(ErrorCode.InvalidRequest, `Conflict ID ${row.id} is not active (status: ${row.status}).`);
            }
        }
        
        // Mark conflicts as deprecated
        await client.query(`UPDATE homelab_memory_v2 SET status = 'deprecated', updated_at = NOW() WHERE id IN (${placeholders})`, conflict_ids);
        
        // Add action trace documenting the merge
        const actionTrace = JSON.stringify([{ action: "resolved_conflict", conflict_ids, timestamp: new Date().toISOString() }]);
        
        const category = checkRes.rows[0].category;

        const res = await client.query(`
            INSERT INTO homelab_memory_v2 
            (category, content, embedding, author_id, action_trace, status)
            VALUES ($1, $2, $3::vector, $4, $5, 'active')
            RETURNING id
        `, [category, resolution_content, embeddingStr, author_id, actionTrace]);
        
        await client.query('COMMIT');
        return { content: [{ type: "text", text: `[krusch-context] 🔗 Conflicts resolved. Unified State ID: ${res.rows[0].id}` }] };
    } catch (err) {
        await client.query('ROLLBACK');
        throw new McpError(ErrorCode.InternalError, `Database error: ${err.message}`);
    } finally {
        client.release();
    }
}

/**
 * Company Brain v2: Get provenance (history) of a state.
 * @param {object} params
 * @param {string} params.memory_id - UUID to trace
 * @returns {Promise<{content: Array}>} MCP tool response
 */
export async function getProvenance({ memory_id }) {
    if (!memory_id) throw new McpError(ErrorCode.InvalidParams, "Missing memory_id");
    
    const client = await pool.connect();
    try {
        const query = `
            WITH RECURSIVE provenance_tree AS (
                SELECT id, parent_id, version_id, author_id, source_ref, created_at, content, status
                FROM homelab_memory_v2
                WHERE id = $1
                UNION ALL
                SELECT m.id, m.parent_id, m.version_id, m.author_id, m.source_ref, m.created_at, m.content, m.status
                FROM homelab_memory_v2 m
                INNER JOIN provenance_tree pt ON pt.parent_id = m.id
            )
            SELECT * FROM provenance_tree ORDER BY version_id DESC;
        `;
        const res = await client.query(query, [memory_id]);
        if (res.rows.length === 0) {
            return { content: [{ type: "text", text: `No provenance found for ID: ${memory_id}` }] };
        }
        
        let output = `=== 📜 Provenance Trace for ID: ${memory_id} ===\n\n`;
        for (const row of res.rows) {
            output += `--- Version ${row.version_id} | ID: ${row.id} ---\n`;
            output += `Author: ${row.author_id}\n`;
            output += `Source: ${row.source_ref || 'Unknown'}\n`;
            output += `Status: ${row.status}\n`;
            output += `Date: ${row.created_at}\n`;
            output += `Content: ${row.content.substring(0, 100)}...\n\n`;
        }
        return { content: [{ type: "text", text: output }] };
    } catch (err) {
        throw new McpError(ErrorCode.InternalError, `Database error: ${err.message}`);
    } finally {
        client.release();
    }
}

/**
 * Company Brain v2: Update ontology tags across all active memories.
 * @param {object} params
 * @param {string} params.old_tag - Tag to replace
 * @param {string} params.new_tag - Replacement tag
 * @returns {Promise<{content: Array}>} MCP tool response
 */
export async function updateOntology({ old_tag, new_tag }) {
    if (!old_tag || !new_tag) throw new McpError(ErrorCode.InvalidParams, "Missing old_tag or new_tag");
    
    const client = await pool.connect();
    try {
        const res = await client.query(`
            UPDATE homelab_memory_v2 
            SET ontology_tags = array_replace(ontology_tags, $1, $2), updated_at = NOW()
            WHERE $1 = ANY(ontology_tags) AND status = 'active'
        `, [old_tag, new_tag]);
        
        return { content: [{ type: "text", text: `[krusch-context] 🏷️ Ontology updated. Renamed '${old_tag}' to '${new_tag}' in ${res.rowCount} active memories.` }] };
    } catch (err) {
        throw new McpError(ErrorCode.InternalError, `Database error: ${err.message}`);
    } finally {
        client.release();
    }
}

/**
 * Company Brain v2: Lens-Based Retrieval. Search homelab_memory_v2 filtered by read_roles.
 * @param {object} params
 * @param {string} params.query - Semantic search query
 * @param {string[]} params.roles - Roles to filter by
 * @param {number} [params.limit=5] - Max results
 * @param {string} [params.status='active'] - Status filter
 * @returns {Promise<{content: Array}>} MCP tool response
 */
export async function searchLens({ query, roles, limit = 5, status = 'active' }) {
    if (!query || !roles || !Array.isArray(roles) || roles.length === 0) {
        throw new McpError(ErrorCode.InvalidParams, "Missing query or roles array");
    }

    const embeddingArray = await getEmbedding(query, PRIORITY.HIGH);
    if (!embeddingArray) throw new McpError(ErrorCode.InternalError, "Failed to generate embedding");
    const embeddingStr = `[${embeddingArray.join(',')}]`;

    const client = await pool.connect();
    try {
        const res = await client.query(`
            SELECT id, category, content, author_id, source_ref, version_id, created_at, ontology_tags,
                   (1 - (embedding <=> $1::vector)) as similarity
            FROM homelab_memory_v2
            WHERE status = $2
              AND read_roles && $3::text[]
            ORDER BY embedding <=> $1::vector
            LIMIT $4
        `, [embeddingStr, status, roles, limit]);

        if (res.rows.length === 0) {
            return { content: [{ type: "text", text: `=== 🔭 Lens Search: [${roles.join(', ')}] ===\n\nNo matching records found.` }] };
        }

        let output = `=== 🔭 Lens Search: [${roles.join(', ')}] ===\n`;
        for (const r of res.rows) {
            const tagsStr = r.ontology_tags ? ` [Ontology: ${r.ontology_tags.join(', ')}]` : '';
            const dateStr = new Date(r.created_at).toISOString().split('T')[0];
            output += `\n--- Match (Score: ${Number(r.similarity).toFixed(2)}) | ID: ${r.id} | Ver: ${r.version_id} | Date: ${dateStr}${tagsStr} ---\n`;
            output += `Category: ${r.category} | Author: ${r.author_id} | Source: ${r.source_ref || 'None'}\n`;
            output += `${r.content}\n`;
        }
        return { content: [{ type: "text", text: output }] };
    } catch (err) {
        throw new McpError(ErrorCode.InternalError, `Database error: ${err.message}`);
    } finally {
        client.release();
    }
}

/**
 * Company Brain v2: Graph Traversal. Traverse parent/child lineage and linked codebase blobs.
 * @param {object} params
 * @param {string} params.memory_id - UUID to traverse from
 * @param {string} [params.direction='all'] - 'parents', 'children', 'blobs', or 'all'
 * @param {number} [params.depth=3] - Max traversal depth
 * @returns {Promise<{content: Array}>} MCP tool response
 */
export async function traverseGraph({ memory_id, direction = 'all', depth = 3 }) {
    if (!memory_id) throw new McpError(ErrorCode.InvalidParams, "Missing memory_id");
    
    const validDirections = ['parents', 'children', 'blobs', 'actionable', 'all'];
    if (!validDirections.includes(direction)) {
        throw new McpError(ErrorCode.InvalidParams, `Invalid direction. Must be one of: ${validDirections.join(', ')}`);
    }

    const client = await pool.connect();
    try {
        let output = `=== 🕸️ Graph Traversal for ID: ${memory_id} (Direction: ${direction}) ===\n\n`;
        
        // Base node fetch
        const baseRes = await client.query(`SELECT id, category, version_id, author_id, status FROM homelab_memory_v2 WHERE id = $1`, [memory_id]);
        if (baseRes.rows.length === 0) {
            return { content: [{ type: "text", text: `Memory ID ${memory_id} not found.` }] };
        }
        const base = baseRes.rows[0];
        output += `[Base Node] ID: ${base.id} (Ver ${base.version_id}) | Cat: ${base.category} | Status: ${base.status} | Author: ${base.author_id}\n\n`;

        if (direction === 'parents' || direction === 'all') {
            const res = await client.query(`
                WITH RECURSIVE parents AS (
                    SELECT id, parent_id, version_id, author_id, status, 1 as level
                    FROM homelab_memory_v2 WHERE id = $1
                    UNION ALL
                    SELECT m.id, m.parent_id, m.version_id, m.author_id, m.status, p.level + 1
                    FROM homelab_memory_v2 m
                    INNER JOIN parents p ON m.id = p.parent_id
                    WHERE p.level < $2
                )
                SELECT * FROM parents WHERE level > 1 ORDER BY level ASC;
            `, [memory_id, depth + 1]);
            
            output += `--- ⬆️ Parents (Depth ${depth}) ---\n`;
            if (res.rows.length === 0) output += `No parents found.\n`;
            res.rows.forEach(r => {
                output += `${'  '.repeat(r.level - 1)}└─ ID: ${r.id} (Ver ${r.version_id}) [Status: ${r.status}]\n`;
            });
            output += `\n`;
        }

        if (direction === 'children' || direction === 'all') {
            const res = await client.query(`
                WITH RECURSIVE children AS (
                    SELECT id, parent_id, version_id, author_id, status, 1 as level
                    FROM homelab_memory_v2 WHERE id = $1
                    UNION ALL
                    SELECT m.id, m.parent_id, m.version_id, m.author_id, m.status, c.level + 1
                    FROM homelab_memory_v2 m
                    INNER JOIN children c ON c.id = m.parent_id
                    WHERE c.level < $2
                )
                SELECT * FROM children WHERE level > 1 ORDER BY level ASC;
            `, [memory_id, depth + 1]);
            
            output += `--- ⬇️ Children (Depth ${depth}) ---\n`;
            if (res.rows.length === 0) output += `No children found.\n`;
            res.rows.forEach(r => {
                output += `${'  '.repeat(r.level - 1)}└─ ID: ${r.id} (Ver ${r.version_id}) [Status: ${r.status}]\n`;
            });
            output += `\n`;
        }

        if (direction === 'actionable' || direction === 'all') {
            const res = await client.query(`
                WITH RECURSIVE lineage AS (
                    SELECT id, parent_id, version_id, author_id, status, ontology_tags, action_trace, 1 as level
                    FROM homelab_memory_v2 WHERE id = $1
                    UNION ALL
                    SELECT m.id, m.parent_id, m.version_id, m.author_id, m.status, m.ontology_tags, m.action_trace, l.level + 1
                    FROM homelab_memory_v2 m
                    INNER JOIN lineage l ON m.id = l.parent_id
                    WHERE l.level < $2
                )
                SELECT * FROM lineage 
                WHERE level > 1 AND (ontology_tags && ARRAY['commitment', 'escalation', 'decision']::text[] OR action_trace IS NOT NULL)
                ORDER BY level ASC;
            `, [memory_id, depth + 1]);
            
            output += `--- ⚡ Actionable States & Traces (Depth ${depth}) ---\n`;
            if (res.rows.length === 0) output += `No actionable states found.\n`;
            res.rows.forEach(r => {
                const tagsStr = r.ontology_tags ? ` [Ontology: ${r.ontology_tags.join(', ')}]` : '';
                output += `${'  '.repeat(r.level - 1)}└─ ID: ${r.id} (Ver ${r.version_id}) [Status: ${r.status}]${tagsStr}\n`;
                if (r.action_trace) {
                    try {
                        const trace = typeof r.action_trace === 'string' ? JSON.parse(r.action_trace) : r.action_trace;
                        output += `${'  '.repeat(r.level - 1)}     Trace: ${JSON.stringify(trace)}\n`;
                    } catch (e) {
                        output += `${'  '.repeat(r.level - 1)}     Trace: ${r.action_trace}\n`;
                    }
                }
            });
            output += `\n`;
        }

        if (direction === 'blobs' || direction === 'all') {
            const res = await client.query(`
                SELECT blob_id, relationship, created_at 
                FROM memory_to_blob_edges 
                WHERE memory_id = $1
                ORDER BY created_at DESC
            `, [memory_id]);
            
            output += `--- 📄 Linked Codebase Blobs ---\n`;
            if (res.rows.length === 0) output += `No linked blobs found.\n`;
            res.rows.forEach(r => {
                output += `  └─ Blob: ${r.blob_id.substring(0, 12)}... | Relation: ${r.relationship}\n`;
            });
            output += `\n`;
        }

        return { content: [{ type: "text", text: output.trim() }] };
    } catch (err) {
        throw new McpError(ErrorCode.InternalError, `Database error: ${err.message}`);
    } finally {
        client.release();
    }
}

/**
 * Company Brain v2: Link a memory state to a codebase file (blob) to build the organizational graph.
 * @param {object} params
 * @param {string} params.memory_id - The UUID of the memory state
 * @param {string} params.blob_id - The SHA hash of the codebase blob (from PG-Git)
 * @param {string} params.relationship - The relationship type (e.g., 'references', 'fixes', 'implements', 'deprecates')
 * @returns {Promise<{content: Array}>} MCP tool response
 */
export async function linkBlob({ memory_id, blob_id, relationship }) {
    if (!memory_id || !blob_id || !relationship) {
        throw new McpError(ErrorCode.InvalidParams, "Missing memory_id, blob_id, or relationship");
    }

    const client = await pool.connect();
    try {
        // Validate memory_id exists
        const memRes = await client.query('SELECT id FROM homelab_memory_v2 WHERE id = $1', [memory_id]);
        if (memRes.rows.length === 0) {
            throw new McpError(ErrorCode.InvalidParams, `Memory ID ${memory_id} not found.`);
        }

        // Validate blob_id exists in PG-Git
        const blobRes = await client.query('SELECT hash FROM blobs WHERE hash = $1', [blob_id]);
        if (blobRes.rows.length === 0) {
            throw new McpError(ErrorCode.InvalidParams, `Blob ID ${blob_id} not found in PG-Git database.`);
        }

        await client.query(`
            INSERT INTO memory_to_blob_edges (memory_id, blob_id, relationship)
            VALUES ($1, $2, $3)
        `, [memory_id, blob_id, relationship]);

        return { content: [{ type: "text", text: `[krusch-context] 🔗 Linked memory ${memory_id} to blob ${blob_id} (Relationship: ${relationship})` }] };
    } catch (err) {
        throw new McpError(ErrorCode.InternalError, `Database error: ${err.message}`);
    } finally {
        client.release();
    }
}
