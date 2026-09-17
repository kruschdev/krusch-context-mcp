-- ==============================================================================
-- Krusch Context MCP - Unified Database Schema
-- Merging Git DAG, Structural Code Symbols, Episodic Memory, Nuggets & Sessions
-- ==============================================================================

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── 1. Git DAG & Codebase Storage ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS repositories (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) UNIQUE NOT NULL,
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS commits (
    id VARCHAR(40) PRIMARY KEY, -- SHA1 hash
    repository_id INTEGER REFERENCES repositories(id) ON DELETE CASCADE,
    tree_id VARCHAR(40) NOT NULL,
    parent_id VARCHAR(40) REFERENCES commits(id) ON DELETE SET NULL,
    message TEXT NOT NULL,
    author VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS branches (
    id SERIAL PRIMARY KEY,
    repository_id INTEGER REFERENCES repositories(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    commit_id VARCHAR(40) REFERENCES commits(id) ON DELETE SET NULL,
    UNIQUE(repository_id, name)
);

CREATE TABLE IF NOT EXISTS trees (
    id VARCHAR(40) PRIMARY KEY,
    repository_id INTEGER REFERENCES repositories(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tree_entries (
    id SERIAL PRIMARY KEY,
    tree_id VARCHAR(40) REFERENCES trees(id) ON DELETE CASCADE,
    type VARCHAR(10) NOT NULL, -- 'blob' or 'tree'
    name VARCHAR(255) NOT NULL,
    object_id VARCHAR(40) NOT NULL,
    UNIQUE(tree_id, name)
);

CREATE TABLE IF NOT EXISTS blobs (
    id VARCHAR(40) PRIMARY KEY,
    repository_id INTEGER REFERENCES repositories(id) ON DELETE CASCADE,
    content BYTEA NULL,
    size INTEGER NOT NULL,
    file_name VARCHAR(255),
    file_path TEXT,
    summary TEXT,
    storage_mode VARCHAR(10) DEFAULT 'pointer',
    embedding vector(1024),
    last_seen_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(file_name, '') || ' ' || coalesce(file_path, '') || ' ' || coalesce(summary, ''))) STORED
);

CREATE INDEX IF NOT EXISTS idx_commits_repo ON commits(repository_id);
CREATE INDEX IF NOT EXISTS idx_tree_entries_tree ON tree_entries(tree_id);
CREATE INDEX IF NOT EXISTS blobs_embedding_idx ON blobs USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS blobs_tsv_idx ON blobs USING gin(tsv);

-- ── 2. Structural Code Symbols & Dependency Graph ─────────────────────────────

CREATE TABLE IF NOT EXISTS code_symbols (
    id SERIAL PRIMARY KEY,
    blob_id VARCHAR(40) REFERENCES blobs(id) ON DELETE CASCADE,
    repository_id INTEGER REFERENCES repositories(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    symbol_name VARCHAR(255) NOT NULL,
    symbol_type VARCHAR(50) NOT NULL, -- 'function', 'class', 'method', 'type', 'route', 'variable'
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    signature TEXT,
    content TEXT,
    embedding vector(1024),
    tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(symbol_name, '') || ' ' || coalesce(signature, '') || ' ' || coalesce(content, ''))) STORED,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_code_symbols_blob ON code_symbols(blob_id);
CREATE INDEX IF NOT EXISTS idx_code_symbols_repo_name ON code_symbols(repository_id, symbol_name);
CREATE INDEX IF NOT EXISTS idx_code_symbols_type ON code_symbols(symbol_type);
CREATE INDEX IF NOT EXISTS idx_code_symbols_tsv ON code_symbols USING gin(tsv);
CREATE INDEX IF NOT EXISTS idx_code_symbols_embedding ON code_symbols USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS code_symbol_edges (
    id SERIAL PRIMARY KEY,
    repository_id INTEGER REFERENCES repositories(id) ON DELETE CASCADE,
    source_blob_id VARCHAR(40) REFERENCES blobs(id) ON DELETE CASCADE,
    source_path TEXT NOT NULL,
    target_path TEXT NOT NULL,
    relation VARCHAR(50) NOT NULL, -- 'imports', 'requires', 'references'
    symbols TEXT[],
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_edges_source_blob ON code_symbol_edges(source_blob_id);
CREATE INDEX IF NOT EXISTS idx_edges_repo_target ON code_symbol_edges(repository_id, target_path);
CREATE INDEX IF NOT EXISTS idx_edges_repo_source ON code_symbol_edges(repository_id, source_path);

-- ── 3. Episodic Memory & Holographic Nuggets ──────────────────────────────────

CREATE TABLE IF NOT EXISTS ide_agent_memory (
    id SERIAL PRIMARY KEY,
    category VARCHAR(64) NOT NULL,
    content TEXT NOT NULL,
    embedding vector(1024),
    tags TEXT[],
    active_project VARCHAR(128),
    session_id VARCHAR(128),
    status VARCHAR(32) DEFAULT 'ACTIVE',
    superseded_by INTEGER REFERENCES ide_agent_memory(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agent_memory_category ON ide_agent_memory(category);
CREATE INDEX IF NOT EXISTS idx_agent_memory_project ON ide_agent_memory(active_project);
CREATE INDEX IF NOT EXISTS idx_agent_memory_status ON ide_agent_memory(status);
CREATE INDEX IF NOT EXISTS idx_agent_memory_embedding ON ide_agent_memory USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS ide_agent_nuggets (
    id SERIAL PRIMARY KEY,
    name VARCHAR(128) UNIQUE NOT NULL,
    content TEXT NOT NULL,
    tags TEXT[],
    project VARCHAR(128),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ── 4. Cross-Session Bridges & Handoffs ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS session_handoffs (
    id SERIAL PRIMARY KEY,
    project VARCHAR(128) NOT NULL,
    session_id VARCHAR(128) NOT NULL,
    summary TEXT NOT NULL,
    active_tasks JSONB,
    architectural_notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    consumed_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_session_handoffs_project ON session_handoffs(project);
