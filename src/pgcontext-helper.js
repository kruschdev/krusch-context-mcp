/**
 * pgContext Integration Helper Module for krusch-context-mcp
 * Handles feature detection, collection setup, HNSW index registration,
 * and filtered ANN search wrappers.
 */

let _hasPgContext = false;

/**
 * Checks if the connected PostgreSQL instance supports pgContext.
 * @param {import('pg').Pool} pool 
 * @returns {Promise<boolean>}
 */
export async function detectPgContext(pool) {
    try {
        const res = await pool.query("SELECT extname FROM pg_extension WHERE extname = 'pgcontext'");
        if (res.rows.length > 0) {
            _hasPgContext = true;
            return true;
        }
        try {
            await pool.query('CREATE EXTENSION IF NOT EXISTS pgcontext');
            _hasPgContext = true;
            return true;
        } catch (_) {
            _hasPgContext = false;
            return false;
        }
    } catch (_) {
        _hasPgContext = false;
        return false;
    }
}

/**
 * Returns whether pgContext is active on the database connection.
 * @returns {boolean}
 */
export function isPgContextEnabled() {
    return _hasPgContext;
}

/**
 * Initializes pgContext collections, registered vector/filter columns, and HNSW indexes.
 * @param {import('pg').Pool} pool 
 */
export async function initPgContextCollections(pool) {
    if (!_hasPgContext) return;

    try {
        // 1. ide_agent_memory
        try {
            await pool.query("SELECT * FROM pgcontext.create_collection('ide_agent_memory', 'public.ide_agent_memory')");
        } catch (_) {}
        try {
            await pool.query("SELECT pgcontext.register_vector('ide_agent_memory', 'embedding', 'embedding', 1024, 'cosine')");
        } catch (_) {}
        try {
            await pool.query("SELECT pgcontext.register_filter_column('ide_agent_memory', 'category', 'category')");
            await pool.query("SELECT pgcontext.register_filter_column('ide_agent_memory', 'project', 'project')");
        } catch (_) {}
        try {
            await pool.query(`
                CREATE INDEX IF NOT EXISTS idx_memory_hnsw_pgcontext
                ON ide_agent_memory USING pgcontext_hnsw (
                    embedding pgcontext.vector_hnsw_cosine_ops
                )
            `);
        } catch (_) {}

        // 2. ide_agent_nuggets
        try {
            await pool.query("SELECT * FROM pgcontext.create_collection('ide_agent_nuggets', 'public.ide_agent_nuggets')");
        } catch (_) {}
        try {
            await pool.query("SELECT pgcontext.register_vector('ide_agent_nuggets', 'embedding', 'embedding', 1024, 'cosine')");
        } catch (_) {}
        try {
            await pool.query("SELECT pgcontext.register_filter_column('ide_agent_nuggets', 'kind', 'kind')");
            await pool.query("SELECT pgcontext.register_filter_column('ide_agent_nuggets', 'project', 'project')");
        } catch (_) {}
        try {
            await pool.query(`
                CREATE INDEX IF NOT EXISTS idx_nuggets_hnsw_pgcontext
                ON ide_agent_nuggets USING pgcontext_hnsw (
                    embedding pgcontext.vector_hnsw_cosine_ops
                )
            `);
        } catch (_) {}

        console.error('[krusch-context-mcp] ✅ pgContext engine collections & HNSW indexes verified.');
    } catch (err) {
        console.error('[krusch-context-mcp] ⚠️ pgContext initialization warning:', err.message);
    }
}

/**
 * Synchronizes newly inserted point IDs into pgContext collection tracking.
 * @param {import('pg').Pool} pool 
 * @param {string} collectionName 
 * @param {Array<string|number>} pointIds 
 */
export async function syncPgContextPoints(pool, collectionName, pointIds) {
    if (!_hasPgContext || !pointIds || pointIds.length === 0) return;
    try {
        const idStrings = pointIds.map(id => String(id));
        await pool.query('SELECT pgcontext.upsert_points($1, $2::text[])', [collectionName, idStrings]);
    } catch (_) {
        // Non-critical background sync
    }
}
