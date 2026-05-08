import { searchMemory } from './src/memory-engine.js';
async function run() {
  console.log("--- ACTIVITY MEMORY ---");
  const activity = await searchMemory({ category: 'activity', active_project: 'krusch-context-mcp' });
  console.log(JSON.stringify(activity, null, 2));
}
run().catch(console.error);
