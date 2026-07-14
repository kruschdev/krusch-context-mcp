import { pool } from 'pg-git-mcp/db/pool.js';
import { getEmbedding } from 'pg-git-mcp/lib/embedding.js';

async function runPatternMatch() {
    console.log("🔍 Running Action Memory Pattern Matching...");
    const client = await pool.connect();
    try {
        // Detect multiple escalations in the past 24 hours
        const res = await client.query(`
            SELECT id, content, author_id, created_at, ontology_tags 
            FROM memory_v2 
            WHERE status = 'active' 
            AND 'escalation' = ANY(ontology_tags)
            AND created_at >= NOW() - INTERVAL '24 HOURS'
        `);
        
        if (res.rows.length >= 2) {
            console.log(`⚠️ Detected ${res.rows.length} active escalations in the last 24 hours. Generating summary priority...`);
            
            const summary = `System generated priority: Detected multiple escalations (${res.rows.length}). Review required. ` + 
                            res.rows.map(r => `[ID ${r.id}]: ${r.content}`).join(' | ');
            
            const embeddingArray = await getEmbedding(summary);
            const embeddingStr = embeddingArray ? `[${embeddingArray.join(',')}]` : null;

            if (embeddingStr) {
                await client.query(`
                    INSERT INTO memory_v2 (category, content, embedding, author_id, status, ontology_tags)
                    VALUES ('priorities', $1, $2::vector, 'agent:system', 'active', ARRAY['escalation', 'summary'])
                `, [summary, embeddingStr]);
                console.log("✅ Synthesis created.");
            }
        } else {
            console.log("✅ No significant patterns detected.");
        }
    } catch (e) {
        console.error("Pattern match failed:", e);
    } finally {
        client.release();
        pool.end();
    }
}

runPatternMatch();
