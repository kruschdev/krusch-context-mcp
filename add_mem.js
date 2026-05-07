import { addMemory } from './src/memory-engine.js';
import { pool } from 'pg-git/db/pool.js';

async function run() {
  try {
    await addMemory({
      project: 'krusch-context-mcp',
      category: 'activity',
      content: 'Updated README to detail provider-agnostic capabilities, codebase semantic search, repository browsing (read_tree/read_blob), and external framework manuals. Verified that tools correctly decouple contextual memory from reasoning engine.'
    });
    console.log('Activity memory logged successfully.');
  } catch (err) {
    console.error('Error logging memory:', err);
  } finally {
    await pool.end();
    process.exit(0);
  }
}

run();
