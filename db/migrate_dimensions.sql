-- ==============================================================================
-- Krusch Context MCP: Vector Dimension Migration Script
-- ==============================================================================
--
-- This script migrates vector column dimensions between 1024-d (default: bge-large)
-- and 1536-d (e.g., text-embedding-3-small, qwen2.5-coder:1.5b) or arbitrary sizes.
--
-- WARNING: When changing vector dimensions in PostgreSQL / pgvector, vectors with 
-- the old dimension cannot be cast automatically. You must NULL or re-embed existing vectors.
--
-- Usage:
--   psql "$DATABASE_URL" -v target_dim=1536 -f db/migrate_dimensions.sql
--   # Then re-embed files:
--   npm run snapshot -- .
-- ==============================================================================

\set ON_ERROR_STOP on

-- Default target dimension if not passed via psql -v target_dim=...
\if :{?target_dim}
\else
  \set target_dim 1536
\endif

\echo 'Migrating vector columns to dimension :' target_dim '...'

BEGIN;

-- 1. Drop existing vector indexes if present (recreated after migration)
DROP INDEX IF EXISTS idx_blobs_embedding;
DROP INDEX IF EXISTS idx_memory_embedding;
DROP INDEX IF EXISTS idx_nuggets_embedding;
DROP INDEX IF EXISTS idx_symbols_embedding;

-- 2. Alter column types
-- Note: Setting NULL is required because pgvector cannot cast between disparate dimensions
UPDATE blobs SET embedding = NULL;
ALTER TABLE blobs ALTER COLUMN embedding TYPE vector(:target_dim);

UPDATE ide_agent_memory SET embedding = NULL;
ALTER TABLE ide_agent_memory ALTER COLUMN embedding TYPE vector(:target_dim);

UPDATE ide_agent_nuggets SET embedding = NULL;
ALTER TABLE ide_agent_nuggets ALTER COLUMN embedding TYPE vector(:target_dim);

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'code_symbols') THEN
        EXECUTE 'UPDATE code_symbols SET embedding = NULL';
        EXECUTE 'ALTER TABLE code_symbols ALTER COLUMN embedding TYPE vector(' || :target_dim || ')';
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'interaction_memory') THEN
        EXECUTE 'UPDATE interaction_memory SET embedding = NULL';
        EXECUTE 'ALTER TABLE interaction_memory ALTER COLUMN embedding TYPE vector(' || :target_dim || ')';
    END IF;
END $$;

-- 3. Recreate HNSW or IVFFlat indexes if pgvector supports it
-- (HNSW index on vector(:target_dim))
CREATE INDEX IF NOT EXISTS idx_blobs_embedding ON blobs USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_memory_embedding ON ide_agent_memory USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_nuggets_embedding ON ide_agent_nuggets USING hnsw (embedding vector_cosine_ops);

COMMIT;

\echo 'Migration complete to vector(' :target_dim ')!'
\echo 'Next steps:'
\echo '1. Update your .env: EMBED_DIMS=' :target_dim
\echo '2. Re-embed your codebase: npm run snapshot -- .'
