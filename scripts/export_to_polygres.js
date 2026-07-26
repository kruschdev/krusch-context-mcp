#!/usr/bin/env node

/**
 * Polygres.com Cloud Export Script
 * Exports ide_agent_memory, ide_agent_nuggets, interaction_memory, agent_failure_bundles,
 * dataflow_operator_registry, dataflow_pipeline_dags, and arex_research_states to SQL insert statements.
 */

import fs from 'fs/promises';
import path from 'path';
import { pool } from 'pg-git-mcp/db/pool.js';

async function exportToPolygres() {
    console.log('📦 Starting Polygres.com cloud database export...');
    const outputPath = path.resolve(process.cwd(), 'data', 'polygres_migration_dump.sql');
    
    let sqlOutput = `-- Polygres.com Cloud Seeding Dump\n-- Generated on: ${new Date().toISOString()}\n\n`;
    sqlOutput += `CREATE EXTENSION IF NOT EXISTS vector;\n`;
    sqlOutput += `CREATE EXTENSION IF NOT EXISTS "uuid-ossp";\n\n`;

    const client = await pool.connect();
    try {
        // 1. Export ide_agent_memory
        const memRes = await client.query('SELECT id, category, content, tags, embedding::text, created_at, project FROM ide_agent_memory');
        console.log(`- Exporting ${memRes.rows.length} episodic memories...`);
        for (const r of memRes.rows) {
            const tagsVal = r.tags ? `'${r.tags.replace(/'/g, "''")}'` : 'NULL';
            const projVal = r.project ? `'${r.project.replace(/'/g, "''")}'` : 'NULL';
            const contentVal = `'${r.content.replace(/'/g, "''")}'`;
            const embedVal = r.embedding ? `'${r.embedding}'::vector` : 'NULL';
            sqlOutput += `INSERT INTO ide_agent_memory (id, category, content, tags, embedding, created_at, project) VALUES (${r.id}, '${r.category}', ${contentVal}, ${tagsVal}, ${embedVal}, '${r.created_at.toISOString()}', ${projVal}) ON CONFLICT (id) DO NOTHING;\n`;
        }
        sqlOutput += `SELECT setval('ide_agent_memory_id_seq', (SELECT MAX(id) FROM ide_agent_memory));\n\n`;

        // 2. Export ide_agent_nuggets
        const nugRes = await client.query('SELECT id, key, value, kind, embedding::text, created_at, updated_at, project FROM ide_agent_nuggets');
        console.log(`- Exporting ${nugRes.rows.length} holographic nuggets...`);
        for (const r of nugRes.rows) {
            const keyVal = `'${r.key.replace(/'/g, "''")}'`;
            const valVal = `'${r.value.replace(/'/g, "''")}'`;
            const projVal = r.project ? `'${r.project.replace(/'/g, "''")}'` : 'NULL';
            const embedVal = r.embedding ? `'${r.embedding}'::vector` : 'NULL';
            sqlOutput += `INSERT INTO ide_agent_nuggets (id, key, value, kind, embedding, created_at, updated_at, project) VALUES (${r.id}, ${keyVal}, ${valVal}, '${r.kind}', ${embedVal}, '${r.created_at.toISOString()}', '${r.updated_at.toISOString()}', ${projVal}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, embedding = EXCLUDED.embedding;\n`;
        }
        sqlOutput += `SELECT setval('ide_agent_nuggets_id_seq', (SELECT MAX(id) FROM ide_agent_nuggets));\n\n`;

        // 3. Export interaction_memory
        const v2Res = await client.query('SELECT id, category, content, embedding::text, author_id, source_ref, confidence, action_trace, parent_id, version_id, status, ontology_tags, read_roles, write_roles, created_at, updated_at, project FROM interaction_memory');
        console.log(`- Exporting ${v2Res.rows.length} interaction memories (v2 Company Brain)...`);
        for (const r of v2Res.rows) {
            const contentVal = `'${r.content.replace(/'/g, "''")}'`;
            const embedVal = r.embedding ? `'${r.embedding}'::vector` : 'NULL';
            const authorVal = `'${r.author_id.replace(/'/g, "''")}'`;
            const sourceVal = r.source_ref ? `'${r.source_ref.replace(/'/g, "''")}'` : 'NULL';
            const traceVal = r.action_trace ? `'${JSON.stringify(r.action_trace).replace(/'/g, "''")}'::jsonb` : 'NULL';
            const parentVal = r.parent_id ? `'${r.parent_id}'` : 'NULL';
            const projVal = r.project ? `'${r.project.replace(/'/g, "''")}'` : 'NULL';
            const tagsVal = r.ontology_tags ? `ARRAY[${r.ontology_tags.map(t => `'${t.replace(/'/g, "''")}'`).join(',')}]` : 'NULL';
            const readVal = r.read_roles ? `ARRAY[${r.read_roles.map(t => `'${t.replace(/'/g, "''")}'`).join(',')}]` : 'NULL';
            const writeVal = r.write_roles ? `ARRAY[${r.write_roles.map(t => `'${t.replace(/'/g, "''")}'`).join(',')}]` : 'NULL';

            sqlOutput += `INSERT INTO interaction_memory (id, category, content, embedding, author_id, source_ref, confidence, action_trace, parent_id, version_id, status, ontology_tags, read_roles, write_roles, created_at, updated_at, project) VALUES ('${r.id}', '${r.category}', ${contentVal}, ${embedVal}, ${authorVal}, ${sourceVal}, ${r.confidence}, ${traceVal}, ${parentVal}, ${r.version_id}, '${r.status}', ${tagsVal}, ${readVal}, ${writeVal}, '${r.created_at.toISOString()}', '${r.updated_at.toISOString()}', ${projVal}) ON CONFLICT (id) DO NOTHING;\n`;
        }
        sqlOutput += `\n`;

        // 4. Export AI Watch tables
        const failRes = await client.query('SELECT agent_name, error_symptom, trajectory, root_cause, recovery_patch, rerun_status, embedding::text, created_at FROM agent_failure_bundles');
        console.log(`- Exporting ${failRes.rows.length} agent failure bundles...`);
        for (const r of failRes.rows) {
            const agentVal = `'${r.agent_name.replace(/'/g, "''")}'`;
            const errorVal = `'${r.error_symptom.replace(/'/g, "''")}'`;
            const trajVal = `'${JSON.stringify(r.trajectory).replace(/'/g, "''")}'::jsonb`;
            const rootVal = `'${r.root_cause.replace(/'/g, "''")}'`;
            const patchVal = r.recovery_patch ? `'${JSON.stringify(r.recovery_patch).replace(/'/g, "''")}'::jsonb` : 'NULL';
            const embedVal = r.embedding ? `'${r.embedding}'::vector` : 'NULL';
            sqlOutput += `INSERT INTO agent_failure_bundles (agent_name, error_symptom, trajectory, root_cause, recovery_patch, rerun_status, embedding, created_at) VALUES (${agentVal}, ${errorVal}, ${trajVal}, ${rootVal}, ${patchVal}, '${r.rerun_status}', ${embedVal}, '${r.created_at.toISOString()}');\n`;
        }

        await fs.writeFile(outputPath, sqlOutput, 'utf-8');
        console.log(`\n✅ Polygres.com dump created successfully: ${outputPath}`);
    } finally {
        client.release();
        await pool.end();
    }
}

exportToPolygres().catch(err => {
    console.error('❌ Dump failed:', err);
    process.exit(1);
});
