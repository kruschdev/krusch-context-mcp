# Retrieval evals

Source: `scripts/eval_accuracy.js` (cosine search on `blobs.embedding`, bge-large / 1024-d).

| Date (UTC) | Corpus | Model | Recall@1 | Recall@5 | Recall@10 |
|---|---|---|---|---|---|
| 2026-09-18 | pg-git, krusch-context-mcp, krusch-cascade-router (190 blobs) | bge-large (1024) | 1/5 (20.0%) | 3/5 (60.0%) | 3/5 (60.0%) |

Queries are filename gold-set matches, not human relevance labels.
A miss can mean the file was never snapshotted (e.g. sibling repositories not yet indexed), not that the embedder failed.

### Benchmark Run Output
```text
Query: "priority queue for ollama inference fleet"
Top 3 hits:
  1. [72.9%] pg-git/lib/llm-queue.js
  2. [71.9%] krusch-context-mcp/src/llm-queue.js
  3. [71.7%] krusch-cascade-router/README.md
✅ Found expected file at rank 1

Query: "database connection pool setup"
Top 3 hits:
  1. [66.4%] krusch-context-mcp/scratch_query_activity.js
  2. [66.1%] krusch-context-mcp/db/pool.js
  3. [65.5%] krusch-context-mcp/scratch_query_top.js
✅ Found expected file at rank 2

Query: "semantic search across codebase blobs"
Top 3 hits:
  1. [70.5%] pg-git/server/git-engine.js
  2. [69.9%] krusch-context-mcp/src/git-engine.js
  3. [69.4%] krusch-context-mcp/src/unified-retrieval.js
✅ Found expected file at rank 5
```

### How to reproduce
```bash
npm run eval:accuracy
```

### Caveats
- Gold set is 5 queries evaluating dense vector retrieval over `blobs.embedding`.
- Metric is "expected filename in top-k", not hybrid RRF lexical + vector (`search_code`) and not full `krusch_context_retrieve` with AST symbol graph hops and token budget packing.
- Results are not comparable across different embedding dimensions or differing corpus snapshots.
