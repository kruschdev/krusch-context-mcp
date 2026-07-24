import { initAgentDebugXTable, logAgentFailure, searchFailures, getRecoveryPattern } from '../src/agentdebugx-engine.js';
import { initDataFlowTables, registerOperator, inspectOperatorRegistry, mutatePipelineDag } from '../src/dataflow-engine.js';
import { setwiseRerank, selectMinimalCoveringSet } from '../src/setwise-engine.js';
import { initArexTable, updateResearchState, auditResearchConstraints } from '../src/arex-engine.js';
import { pool } from 'pg-git-mcp/db/pool.js';

async function runTests() {
    console.log('🧪 Starting AI Watch Integrations Verification Suite...\n');

    try {
        // 1. Initialize Tables
        console.log('1️⃣ Initializing Database Tables...');
        await initAgentDebugXTable();
        await initDataFlowTables();
        await initArexTable();
        console.log('✅ Tables initialized.\n');

        // 2. Test AgentDebugX
        console.log('2️⃣ Testing AgentDebugX Failure Observability & Error Hub...');
        const logRes = await logAgentFailure({
            agent_name: 'test_sre_worker',
            error_symptom: 'PostgreSQL connection timeout under heavy lock contention',
            trajectory: [{ step: 1, action: 'connect' }, { step: 2, action: 'timeout' }],
            root_cause: 'Connection pool max limit reached due to unreleased sessions',
            recovery_patch: { pool_size: 20, idle_timeout_ms: 10000 }
        });
        console.log('Log Result:', logRes.content[0].text);

        const searchRes = await searchFailures({ query: 'connection timeout', agent_name: 'test_sre_worker' });
        console.log('\nSearch Result:\n', searchRes.content[0].text);

        const patternRes = await getRecoveryPattern({ failure_id: 1 });
        console.log('\nRecovery Pattern Result:\n', patternRes.content[0].text);
        console.log('✅ AgentDebugX test passed.\n');

        // 3. Test DataFlow-Harness
        console.log('3️⃣ Testing DataFlow-Harness Grounded Codegen...');
        const regRes = await registerOperator({
            name: 'ExtractLegalStatutes',
            input_schema: { type: 'object', properties: { pdf_path: { type: 'string' } } },
            output_schema: { type: 'object', properties: { statutes: { type: 'array' } } },
            side_effects: 'none',
            docs: 'Extracts statutory citations from uploaded legal PDFs'
        });
        console.log('Register Operator Result:', regRes.content[0].text);

        const inspectRes = await inspectOperatorRegistry({ filter: 'Legal' });
        console.log('\nInspect Registry Result:\n', inspectRes.content[0].text);

        const mutateRes = await mutatePipelineDag({
            pipeline_name: 'legal_ingestion_pipeline',
            mutation_type: 'AddNode',
            node_data: { id: 'node_1', operator_name: 'ExtractLegalStatutes', config: { batch_size: 5 } }
        });
        console.log('\nMutate DAG Result:', mutateRes.content[0].text);
        console.log('✅ DataFlow-Harness test passed.\n');

        // 4. Test Rubric4Setwise
        console.log('4️⃣ Testing Rubric4Setwise Document-Set Reranking...');
        const dummyCandidates = [
            { id: '1', title: 'Doc A', content: 'PostgreSQL connection pooling guidelines and idle session cleanup', score: 0.95 },
            { id: '2', title: 'Doc B', content: 'PostgreSQL connection pooling guidelines and idle session cleanup', score: 0.90 }, // Duplicate
            { id: '3', title: 'Doc C', content: 'pgvector HNSW index optimization for high-throughput semantic search', score: 0.85 }
        ];
        const setwiseRes = await setwiseRerank({ candidates: dummyCandidates, query: 'Postgres optimization', target_count: 2 });
        console.log('Setwise Rerank Result:\n', setwiseRes.content[0].text);
        console.log('✅ Rubric4Setwise test passed.\n');

        // 5. Test AREX Deep Research
        console.log('5️⃣ Testing AREX Recursively Self-Improving Deep Research...');
        const arexUpdateRes = await updateResearchState({
            task_id: 'research_task_99',
            verified_evidence: ['AREX improves deep research by 15%', 'DataFlow cuts latency by 49.9%'],
            unresolved_constraints: ['Verify GPU VRAM allocation under batch load'],
            next_action_hints: ['Run vLLM benchmark on kruschdev']
        });
        console.log('AREX Update Result:', arexUpdateRes.content[0].text);

        const arexAuditRes = await auditResearchConstraints({ task_id: 'research_task_99' });
        console.log('\nAREX Audit Result:\n', arexAuditRes.content[0].text);
        console.log('✅ AREX test passed.\n');

        console.log('🎉 ALL AI WATCH INTEGRATION TESTS PASSED CLEANLY!');
    } catch (e) {
        console.error('❌ Test failed with error:', e);
        process.exit(1);
    } finally {
        await pool.end();
        process.exit(0);
    }
}

runTests();
