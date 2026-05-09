import { addMemory, consolidateMemories, searchMemory, listMemories, deleteMemory } from '../src/memory-engine.js';
import { getProjectDb } from '../src/sqlite-engine.js';
import fs from 'fs';
import path from 'path';

const TEST_PROJECT = 'stress-test-consolidation-temp';
const CATEGORY = 'lessons';

// Synthetic highly-overlapping memories simulating Ebbinghaus forgetting (F6) 
// where specific details (like 8 PM or Alacritty) might be lost in the centroid.
const TEST_MEMORIES = [
    "The user strongly prefers dark mode on macOS for all their coding environments.",
    "User configures dark mode for their primary IDE at 8 PM every evening.",
    "Dark mode is the user's favorite theme on macOS, especially for late night work.",
    "User enabled the dark mode system theme on their new M3 MacBook Pro.",
    "The user uses a custom dark mode color palette for their terminal emulator (Alacritty).",
    "MacOS dark mode settings are automated via a shell script by the user.",
    "The user explicitly dislikes light mode and forces dark mode across all web apps.",
    "Dark mode reduces eye strain for the user during long coding sessions.",
    "User frequently switches their VS Code theme to a high-contrast dark mode.",
    "The dark mode preference is synced across the user's homelab fleet via dotfiles."
];

async function cleanup() {
    console.log(`\n🧹 Cleaning up test project: ${TEST_PROJECT}...`);
    try {
        const db = await getProjectDb(TEST_PROJECT);
        if (db) {
            db.prepare(`DELETE FROM ide_agent_memory WHERE category = ?`).run(CATEGORY);
            console.log(`✅ Cleanup complete.`);
        }
    } catch (e) {
        console.error("Failed to cleanup:", e);
    }
}

async function runStressTest(threshold) {
    console.log(`\n======================================================`);
    console.log(`🚀 Starting Consolidation Stress Test (Threshold: ${threshold})`);
    console.log(`======================================================`);
    
    await cleanup();

    console.log(`\n📥 Seeding ${TEST_MEMORIES.length} highly overlapping memories...`);
    for (const [idx, mem] of TEST_MEMORIES.entries()) {
        process.stdout.write(`  Embedding [${idx+1}/${TEST_MEMORIES.length}]... `);
        await addMemory({
            category: CATEGORY,
            content: mem,
            project: TEST_PROJECT
        });
        console.log(`Done.`);
    }

    console.log(`\n🔗 Running consolidateMemories() at threshold ${threshold}...`);
    let totalMerged = 0;
    while (true) {
        const result = await consolidateMemories({
            category: CATEGORY,
            project: TEST_PROJECT,
            threshold: threshold
        });
        
        const output = result.content[0].text;
        console.log(`  ${output}`);
        
        const match = output.match(/Consolidated (\d+)/);
        if (match && parseInt(match[1]) > 0) {
            totalMerged += parseInt(match[1]);
        } else {
            break; // No more merges
        }
    }
    
    console.log(`\n📊 Total pairs merged: ${totalMerged}`);
    
    // Check resulting memories count
    const listResult = await listMemories({ category: CATEGORY, project: TEST_PROJECT, limit: 100 });
    const matchCount = (listResult.content[0].text.match(/--- ID:/g) || []).length;
    console.log(`Remaining distinct memory clusters: ${matchCount}`);

    // F6 Ebbinghaus Forgetting Test: Can we still retrieve the specific detail "8 PM"?
    console.log(`\n🔍 F6 Ebbinghaus Recall Test: "What time does the user configure their IDE theme?"`);
    const searchRes = await searchMemory({
        category: CATEGORY,
        query: "What time does the user configure their IDE theme?",
        limit: 3,
        active_project: TEST_PROJECT
    });
    
    const searchText = searchRes.content[0].text;
    console.log(searchText);
    
    if (searchText.includes("8 PM")) {
        console.log(`✅ PASS: Specific detail "8 PM" survived centroid collapse and was retrieved!`);
    } else {
        console.log(`❌ FAIL (F6 Forgetting): Centroid drifted too far. The specific detail "8 PM" was lost in the embedding space.`);
    }

    // F4 Hubness Test: Is there one massive cluster dominating?
    console.log(`\n🔍 F4 Hubness Test: Querying an unrelated fact "How does the user configure their network router?"`);
    const unrelatedRes = await searchMemory({
        category: CATEGORY,
        query: "How does the user configure their network router?",
        limit: 1,
        active_project: TEST_PROJECT
    });
    
    const unrelatedText = unrelatedRes.content[0].text;
    const scoreMatch = unrelatedText.match(/Score: (0\.\d+)/);
    if (scoreMatch) {
        const score = parseFloat(scoreMatch[1]);
        if (score > 0.85) {
            console.log(`❌ FAIL (F4 Hubness): The dark mode cluster is acting as a universal hub! (Score: ${score} for unrelated query)`);
        } else {
            console.log(`✅ PASS: Hubness controlled. Unrelated query scored reasonably low (${score}).`);
        }
    } else {
        console.log("No score extracted, skipping Hubness evaluation.");
    }
}

async function main() {
    try {
        // Run sweep over multiple thresholds to see geometry effects
        await runStressTest(0.10); // Strict
        await runStressTest(0.20); // Moderate
        await runStressTest(0.35); // Aggressive merge (likely causes F6 forgetting)
        
        console.log(`\n✨ Stress test complete.`);
    } catch (e) {
        console.error("Error during stress test:", e);
    } finally {
        await cleanup();
        process.exit(0);
    }
}

main();
