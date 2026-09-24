-- ==============================================================================
-- Krusch Context MCP - PostgreSQL Schema
-- Working Memory, Steering Invariants & Holographic Nuggets
-- ==============================================================================

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── 1. Episodic Memory (Closed Taxonomy: decision, bug, invariant, lesson, blocker)

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
    supersedes_id INTEGER REFERENCES ide_agent_memory(id) ON DELETE SET NULL,
    invalidated_reason TEXT,
    provenance JSONB,
    valid_until TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agent_memory_category ON ide_agent_memory(category);
CREATE INDEX IF NOT EXISTS idx_agent_memory_project ON ide_agent_memory(active_project);
CREATE INDEX IF NOT EXISTS idx_agent_memory_status ON ide_agent_memory(status);
CREATE INDEX IF NOT EXISTS idx_agent_memory_embedding ON ide_agent_memory USING hnsw (embedding vector_cosine_ops);

-- ── 2. Holographic Steering Nuggets (KV facts) ─────────────────────────────────

CREATE TABLE IF NOT EXISTS ide_agent_nuggets (
    id SERIAL PRIMARY KEY,
    key VARCHAR(128) UNIQUE NOT NULL,
    value TEXT NOT NULL,
    kind VARCHAR(64) NOT NULL DEFAULT 'project',
    embedding vector(1024),
    project VARCHAR(128),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agent_nuggets_key ON ide_agent_nuggets(key);
CREATE INDEX IF NOT EXISTS idx_agent_nuggets_project ON ide_agent_nuggets(project);
CREATE INDEX IF NOT EXISTS idx_agent_nuggets_embedding ON ide_agent_nuggets USING hnsw (embedding vector_cosine_ops);

-- ── 3. Auditor & Pre-Commit Invariant Feedback ────────────────────────────────

CREATE TABLE IF NOT EXISTS auditor_feedback (
    id SERIAL PRIMARY KEY,
    project VARCHAR(128),
    rule_id TEXT NOT NULL,
    feedback TEXT NOT NULL, -- 'helpful' | 'false_positive' | 'irrelevant'
    context_diff TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_auditor_feedback_rule ON auditor_feedback(rule_id);
