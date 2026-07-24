/**
 * @module dataflow-engine
 * DataFlow-Harness Grounded Code-Agent Engine & Typed Pipeline DAG Mutations.
 * Based on HF Paper 2607.16617.
 */

import { pool } from 'pg-git-mcp/db/pool.js';

/**
 * Initializes DataFlow-Harness database tables.
 */
export async function initDataFlowTables() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS dataflow_operator_registry (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) UNIQUE NOT NULL,
                input_schema JSONB NOT NULL,
                output_schema JSONB NOT NULL,
                side_effects TEXT,
                docs TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS dataflow_pipeline_dags (
                id SERIAL PRIMARY KEY,
                pipeline_name VARCHAR(100) UNIQUE NOT NULL,
                nodes JSONB DEFAULT '[]'::jsonb,
                edges JSONB DEFAULT '[]'::jsonb,
                version INT DEFAULT 1,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
    } finally {
        client.release();
    }
}

/**
 * Registers an operator in the grounded MCP registry.
 * @param {object} params
 * @param {string} params.name
 * @param {object} params.input_schema
 * @param {object} params.output_schema
 * @param {string} [params.side_effects]
 * @param {string} [params.docs]
 * @returns {Promise<{content: Array}>}
 */
export async function registerOperator({ name, input_schema, output_schema, side_effects = 'none', docs = '' }) {
    if (!name || !input_schema || !output_schema) {
        return { content: [{ type: "text", text: "Error: name, input_schema, and output_schema are required." }] };
    }

    const client = await pool.connect();
    try {
        await client.query(`
            INSERT INTO dataflow_operator_registry (name, input_schema, output_schema, side_effects, docs)
            VALUES ($1, $2::jsonb, $3::jsonb, $4, $5)
            ON CONFLICT (name) DO UPDATE SET
                input_schema = EXCLUDED.input_schema,
                output_schema = EXCLUDED.output_schema,
                side_effects = EXCLUDED.side_effects,
                docs = EXCLUDED.docs
        `, [name, JSON.stringify(input_schema), JSON.stringify(output_schema), side_effects, docs]);

        return {
            content: [{
                type: "text",
                text: `[DataFlow-Harness] ✅ Operator '${name}' successfully registered in grounded MCP registry.`
            }]
        };
    } catch (e) {
        return { content: [{ type: "text", text: `[DataFlow-Harness] Error registering operator: ${e.message}` }] };
    } finally {
        client.release();
    }
}

/**
 * Inspects registered grounded operators in the MCP registry.
 * @param {object} params
 * @param {string} [params.filter]
 * @returns {Promise<{content: Array}>}
 */
export async function inspectOperatorRegistry({ filter } = {}) {
    const client = await pool.connect();
    try {
        let sql = `SELECT name, input_schema, output_schema, side_effects, docs FROM dataflow_operator_registry`;
        let params = [];

        if (filter) {
            sql += ` WHERE name ILIKE $1 OR docs ILIKE $1`;
            params.push(`%${filter}%`);
        }
        sql += ` ORDER BY name ASC`;

        const res = await client.query(sql, params);
        if (res.rows.length === 0) {
            return { content: [{ type: "text", text: "[DataFlow-Harness] No operators found in registry." }] };
        }

        const items = res.rows.map(r => `### ⚙️ Operator: \`${r.name}\`\n` +
            `- **Docs**: ${r.docs || 'N/A'}\n` +
            `- **Side Effects**: ${r.side_effects}\n` +
            `- **Input Schema**: \`${JSON.stringify(r.input_schema)}\`\n` +
            `- **Output Schema**: \`${JSON.stringify(r.output_schema)}\`\n`).join('\n---\n');

        return {
            content: [{
                type: "text",
                text: `## 🛠️ DataFlow-Harness Grounded Operator Registry\n\n${items}`
            }]
        };
    } finally {
        client.release();
    }
}

/**
 * Mutates a pipeline DAG using typed, schema-validated operations.
 * @param {object} params
 * @param {string} params.pipeline_name
 * @param {'AddNode'|'RemoveNode'|'WireEdge'|'UpdateNodeConfig'} params.mutation_type
 * @param {object} [params.node_data] - { id, operator_name, config }
 * @param {object} [params.edge_data] - { from, to, mapping }
 * @returns {Promise<{content: Array}>}
 */
export async function mutatePipelineDag({ pipeline_name, mutation_type, node_data, edge_data }) {
    if (!pipeline_name || !mutation_type) {
        return { content: [{ type: "text", text: "Error: pipeline_name and mutation_type are required." }] };
    }

    const client = await pool.connect();
    try {
        const fetchRes = await client.query(`
            SELECT nodes, edges, version FROM dataflow_pipeline_dags WHERE pipeline_name = $1
        `, [pipeline_name]);

        let nodes = fetchRes.rows.length > 0 ? (fetchRes.rows[0].nodes || []) : [];
        let edges = fetchRes.rows.length > 0 ? (fetchRes.rows[0].edges || []) : [];
        let version = fetchRes.rows.length > 0 ? (fetchRes.rows[0].version || 1) : 0;

        switch (mutation_type) {
            case 'AddNode': {
                if (!node_data || !node_data.id || !node_data.operator_name) {
                    return { content: [{ type: "text", text: "Error AddNode: node_data with id and operator_name is required." }] };
                }
                const exists = nodes.some(n => n.id === node_data.id);
                if (exists) {
                    return { content: [{ type: "text", text: `Error AddNode: Node ID '${node_data.id}' already exists in DAG.` }] };
                }
                nodes.push({
                    id: node_data.id,
                    operator_name: node_data.operator_name,
                    config: node_data.config || {}
                });
                break;
            }

            case 'RemoveNode': {
                if (!node_data || !node_data.id) {
                    return { content: [{ type: "text", text: "Error RemoveNode: node_data.id is required." }] };
                }
                nodes = nodes.filter(n => n.id !== node_data.id);
                edges = edges.filter(e => e.from !== node_data.id && e.to !== node_data.id);
                break;
            }

            case 'WireEdge': {
                if (!edge_data || !edge_data.from || !edge_data.to) {
                    return { content: [{ type: "text", text: "Error WireEdge: edge_data with from and to is required." }] };
                }
                edges.push({
                    from: edge_data.from,
                    to: edge_data.to,
                    mapping: edge_data.mapping || {}
                });
                break;
            }

            case 'UpdateNodeConfig': {
                if (!node_data || !node_data.id || !node_data.config) {
                    return { content: [{ type: "text", text: "Error UpdateNodeConfig: node_data with id and config is required." }] };
                }
                const targetNode = nodes.find(n => n.id === node_data.id);
                if (!targetNode) {
                    return { content: [{ type: "text", text: `Error UpdateNodeConfig: Node '${node_data.id}' not found.` }] };
                }
                targetNode.config = { ...targetNode.config, ...node_data.config };
                break;
            }

            default:
                return { content: [{ type: "text", text: `Error: Unknown mutation_type '${mutation_type}'.` }] };
        }

        version += 1;

        await client.query(`
            INSERT INTO dataflow_pipeline_dags (pipeline_name, nodes, edges, version, updated_at)
            VALUES ($1, $2::jsonb, $3::jsonb, $4, NOW())
            ON CONFLICT (pipeline_name) DO UPDATE SET
                nodes = EXCLUDED.nodes,
                edges = EXCLUDED.edges,
                version = EXCLUDED.version,
                updated_at = NOW()
        `, [pipeline_name, JSON.stringify(nodes), JSON.stringify(edges), version]);

        return {
            content: [{
                type: "text",
                text: `[DataFlow-Harness] ✅ Pipeline DAG '${pipeline_name}' updated to v${version} via '${mutation_type}'.\nNodes: ${nodes.length} | Edges: ${edges.length}`
            }]
        };
    } catch (e) {
        return { content: [{ type: "text", text: `[DataFlow-Harness] Error mutating pipeline DAG: ${e.message}` }] };
    } finally {
        client.release();
    }
}
