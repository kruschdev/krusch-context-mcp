import { getProjectDb, pushProjectMemory } from '../src/sqlite-engine.js';
import { addMemory } from '../src/memory-engine.js';
import { pool } from 'pg-git-mcp/db/pool.js';

async function runTest() {
    try {
        console.log("0. Running migrations manually...");
        const client = await pool.connect();
        try {
            await client.query('ALTER TABLE ide_agent_nuggets ADD COLUMN project VARCHAR(255)');
        } catch (e) {
            if (e.code !== '42701') console.error(e);
        }
        client.release();

        console.log("1. Adding memory to sqlite cache...");
        const res = await addMemory({
            project: "krusch-context-mcp",
            category: "lessons",
            content: "Lakebase architecture test successfully inserted at " + Date.now(),
            tags: ["test", "lakebase"],
            _embedding: new Array(1024).fill(0.1) // dummy embedding
        });
        console.log(res.content[0].text);
        
        console.log("2. Waiting 3 seconds for async push to Postgres...");
        await new Promise(r => setTimeout(r, 3000));
        
        console.log("3. Querying Postgres object storage...");
        const client2 = await pool.connect();
        const pgRes = await client2.query("SELECT * FROM ide_agent_memory WHERE project = 'krusch-context-mcp' ORDER BY created_at DESC LIMIT 1");
        console.log(`Latest Postgres Record ID: ${pgRes.rows[0].id}`);
        console.log(`Content: ${pgRes.rows[0].content}`);
        client2.release();
        
    } catch (e) {
        console.error(e);
    } finally {
        await pool.end();
        process.exit(0);
    }
}

runTest();
