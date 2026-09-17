import { strict as assert } from 'assert';
import dotenv from 'dotenv';
import {
    getCloudUsage,
    getCloudEmbeddingModels,
    getCloudCapabilities,
    listCloudEmbeddingConfigs,
    searchCloudContext
} from '../src/polygres-cloud.js';

dotenv.config();

async function runTests() {
    console.log('🧪 Starting Polygres Cloud Integration Tests...\n');
    let passed = 0;
    let failed = 0;

    // Test 1: Cloud Usage & 500M Microcredits Verification
    console.log('▶ Test 1: Polygres Cloud Credit Usage Check');
    try {
        const usage = await getCloudUsage();
        assert.ok(usage.project_id, 'Usage should contain project_id');
        assert.ok(usage.generation, 'Usage should contain generation credits');
        assert.ok(usage.query, 'Usage should contain query credits');
        assert.ok(usage.summaryText.includes('microcredits remaining'), 'Summary text should be generated');

        console.log(`  ✅ Successfully fetched cloud usage for project: ${usage.project_id}`);
        console.log(`  📊 Summary:\n${usage.summaryText.split('\n').map(l => '     ' + l).join('\n')}\n`);
        passed++;
    } catch (err) {
        console.error(`  ❌ Failed: ${err.message}\n`);
        failed++;
    }

    // Test 2: In-Engine Embedding Models Discovery
    console.log('▶ Test 2: In-Engine Embedding Models Discovery');
    try {
        const modelsRes = await getCloudEmbeddingModels();
        assert.ok(Array.isArray(modelsRes.models), 'Models should be an array');
        assert.ok(modelsRes.models.length >= 2, 'Should discover at least 2 models');
        
        const modelNames = modelsRes.models.map(m => `${m.name} (${m.provider}, dims: [${m.dimensions.join(',')}])`);
        console.log(`  ✅ Discovered ${modelsRes.models.length} in-engine embedding models:`);
        modelNames.forEach(m => console.log(`     • ${m}`));
        console.log('');
        passed++;
    } catch (err) {
        console.error(`  ❌ Failed: ${err.message}\n`);
        failed++;
    }

    // Test 3: pgContext Engine Capabilities & HNSW Limits
    console.log('▶ Test 3: pgContext Capabilities & HNSW Limits');
    try {
        const caps = await getCloudCapabilities();
        assert.ok(caps.contract_version, 'Capabilities should have contract_version');
        assert.ok(caps.hnsw_record_limits, 'Should have hnsw_record_limits');
        console.log(`  ✅ Contract Version: ${caps.contract_version}`);
        console.log(`  ✅ pgContext Version: ${caps.hnsw_record_limits.pgcontext_version}`);
        console.log(`  ✅ Max Record Bytes: ${caps.hnsw_record_limits.max_record_bytes} | HNSW M: ${caps.hnsw_record_limits.hnsw_m}\n`);
        passed++;
    } catch (err) {
        console.error(`  ❌ Failed: ${err.message}\n`);
        failed++;
    }

    // Test 4: Watched Table Embedding Configurations List
    console.log('▶ Test 4: Watched Table Embedding Configurations');
    try {
        const configs = await listCloudEmbeddingConfigs();
        assert.ok(Array.isArray(configs.configurations), 'Configurations should be an array');
        console.log(`  ✅ Successfully queried embedding configurations (${configs.configurations.length} active pipelines)\n`);
        passed++;
    } catch (err) {
        console.error(`  ❌ Failed: ${err.message}\n`);
        failed++;
    }

    console.log('========================================');
    console.log(`📊 Polygres Cloud Test Results: ${passed} Passed | ${failed} Failed`);
    console.log('========================================\n');

    process.exit(failed === 0 ? 0 : 1);
}

runTests();
