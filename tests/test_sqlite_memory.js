import { addMemory, searchMemory, listMemories } from '../src/memory-engine.js';

(async () => {
    try {
        console.log("Adding memory...");
        await addMemory({
            category: "lessons",
            content: "Testing project separation with SQLite! This should only appear for krusch-nexus.",
            project: "krusch-nexus",
            tags: ["test", "sqlite"]
        });
        
        console.log("\nSearching memory (with project)...");
        const res1 = await searchMemory({ category: "lessons", query: "SQLite project separation", limit: 3, active_project: "krusch-nexus" });
        console.log(res1.content[0].text);
        
        console.log("\nSearching memory (without project - global only)...");
        const res2 = await searchMemory({ category: "lessons", query: "SQLite project separation", limit: 3 });
        console.log(res2.content[0].text);
        
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
})();
