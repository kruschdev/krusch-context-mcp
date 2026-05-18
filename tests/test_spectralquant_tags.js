#!/usr/bin/env node

/**
 * @module test_spectralquant_tags
 * Standalone smoke test to verify SpectralQuant KV compression bridge integration
 * inside krusch-context-mcp for semantic tag generation.
 */

import { generateTagsFromLLM } from '../src/llm-tags.js';

async function run() {
    console.log("🚀 Testing SpectralQuant Tag Generation...");
    console.log("--------------------------------------------------");
    
    const sampleText = `
        The system should implement a resilient failover mechanism using PostgreSQL 
        as the primary data store and falling back to SQLite if the connection drops.
        It must ensure ACID compliance and guarantee idempotency across distributed nodes.
    `;
    
    console.log("📝 Input Text:");
    console.log(sampleText.trim());
    console.log("--------------------------------------------------");
    console.log("⏳ Waiting for SpectralQuant proxy response...\n");

    const startTime = Date.now();
    
    try {
        const tags = await generateTagsFromLLM(sampleText, {
            lowercase: true,
            asJson: false
        });
        
        const latencyMs = Date.now() - startTime;
        
        if (tags && tags.length > 0) {
            console.log(`✅ Success! Extracted ${tags.length} tags in ${latencyMs}ms:`);
            console.dir(tags, { colors: true });
        } else {
            console.error(`❌ Failed: Received empty or null tags in ${latencyMs}ms.`);
            console.dir(tags);
            process.exit(1);
        }
    } catch (e) {
        const latencyMs = Date.now() - startTime;
        console.error(`❌ Error executing SpectralQuant bridge test after ${latencyMs}ms:`);
        console.error(e);
        process.exit(1);
    }
}

run();
