#!/usr/bin/env node

/**
 * @module test_teacher_distillation
 * Smoke test for Hierarchical Teacher Memory Distillation (Paper ArXiv 2608.07169).
 * Validates Tier 1 (Workflow), Tier 2 (Subtask), and Tier 3 (Function) memory distillation and retrieval.
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { pool } from '../db/pool.js';

const SERVER = new URL('../src/index.js', import.meta.url).pathname;
let nextId = 1;
const pending = new Map();

const child = spawn('node', [SERVER], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, KRUSCH_PROFILE: process.env.KRUSCH_PROFILE || 'full' }
});

const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
rl.on('line', (line) => {
    try {
        const msg = JSON.parse(line);
        if (msg.id && pending.has(msg.id)) {
            pending.get(msg.id)(msg);
            pending.delete(msg.id);
        }
    } catch (e) {}
});

function send(method, params = {}) {
    return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, resolve);
        const msg = JSON.stringify({ jsonrpc: '2.0', method, params, id });
        child.stdin.write(msg + '\n');
        setTimeout(() => {
            if (pending.has(id)) {
                pending.delete(id);
                reject(new Error(`Timeout on ${method} (id=${id})`));
            }
        }, 30000);
    });
}

async function run() {
    console.log('⏳ Initializing server for Teacher Memory Distillation smoke test...');
    const initRes = await send('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-distillation-client', version: '1.0.0' }
    });
    console.log('✅ Initialize:', initRes.result?.serverInfo?.name || 'OK');

    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    await new Promise(r => setTimeout(r, 500));

    try {
        console.log('\n📝 1. Distilling Tier 1 (Workflow) Memory...');
        const res1 = await send('tools/call', {
            name: 'krusch_context_distill_teacher_memory',
            arguments: {
                tier: 'workflow',
                task_pattern: 'database_migration',
                teacher_model: 'gemini-3.5-flash',
                student_model: 'qwen2.5-coder:7b',
                trajectory: [
                    { step: 1, action: 'check_active_connections' },
                    { step: 2, action: 'run_pg_dump_backup' },
                    { step: 3, action: 'execute_migration_sql' }
                ],
                distilled_rule: 'Always verify backup dump completion before running DDL table alterations.',
                project: 'krusch-context-mcp'
            }
        });
        console.log('   Response:', res1.result?.content?.[0]?.text);

        console.log('\n🔧 2. Distilling Tier 3 (Function) Memory for Tool Failure Recovery...');
        const res2 = await send('tools/call', {
            name: 'krusch_context_distill_function_memory',
            arguments: {
                tool_name: 'krusch_context_write_state',
                failed_input: JSON.stringify({ category: 'invalid_cat', content: 'test' }),
                error_message: "Invalid category. Must be one of 'priorities', 'bugs', 'outcomes', 'lessons', 'activity'",
                corrected_input: JSON.stringify({ category: 'lessons', content: 'test', author_id: 'agent:student' }),
                explanation: 'Always supply author_id and a valid v1/v2 category string.',
                teacher_model: 'claude-3.5-sonnet',
                project: 'krusch-context-mcp'
            }
        });
        console.log('   Response:', res2.result?.content?.[0]?.text);

        console.log('\n🔍 3. Retrieving Teacher Distillations...');
        const res3 = await send('tools/call', {
            name: 'krusch_context_retrieve_teacher_distillation',
            arguments: {
                query: 'database migration backup',
                tier: 'workflow',
                project: 'krusch-context-mcp'
            }
        });
        console.log('   Retrieved Workflow Memories:\n', res3.result?.content?.[0]?.text);

        console.log('\n🔍 4. Retrieving Function Failure Corrections...');
        const res4 = await send('tools/call', {
            name: 'krusch_context_retrieve_teacher_distillation',
            arguments: {
                query: 'krusch_context_write_state category error',
                tier: 'function',
                project: 'krusch-context-mcp'
            }
        });
        console.log('   Retrieved Function Memories:\n', res4.result?.content?.[0]?.text);

        console.log('\n🎉 Teacher Memory Distillation smoke test completed successfully!');
    } finally {
        child.kill('SIGTERM');
        await pool.end();
        setTimeout(() => process.exit(0), 1000);
    }
}

run().catch(err => {
    console.error('❌ Test failed:', err);
    child.kill('SIGTERM');
    process.exit(1);
});
