-- ==============================================================================
-- Krusch Context MCP: Vector Dimension Migration Script
-- ==============================================================================
--
-- This script migrates memory and nugget vector column dimensions between
-- 1024-d (default: bge-large) and 1536-d or arbitrary sizes in PostgreSQL.
--
-- Usage:
--   psql "$DATABASE_URL" -v target_dim=1536 -f db/migrate_dimensions.sql
-- ==============================================================================

\set ON_ERROR_STOP on

\if :{?target_dim}
\else
  \set target_dim 1536
\endif

\echo 'Migrating memory vector columns to dimension :' target_dim '...'

BEGIN;

-- 1. Drop existing vector indexes
DROP INDEX IF EXISTS idx_agent_memory_embedding;
DROP INDEX IF EXISTS idx_agent_nuggets_embedding;
DROP INDEX IF EXISTS idx_memory_embedding;
DROP INDEX IF EXISTS idx_nuggets_embedding;

-- 2. Alter column types (pgvector requires clearing before dimension change)
UPDATE ide_agent_memory SET embedding = NULL;
ALTER TABLE ide_agent_memory ALTER COLUMN embedding TYPE vector(:target_dim);

UPDATE ide_agent_nuggets SET embedding = NULL;
ALTER TABLE ide_agent_nuggets ALTER COLUMN embedding TYPE vector(:target_dim);

-- 3. Recreate HNSW indexes
CREATE INDEX IF NOT EXISTS idx_agent_memory_embedding ON ide_agent_memory USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_agent_nuggets_embedding ON ide_agent_nuggets USING hnsw (embedding vector_cosine_ops);

COMMIT;

\echo 'Migration complete to vector(' :target_dim ')!'
\echo 'Remember to update your .env: EMBED_DIMS=' :target_dim
