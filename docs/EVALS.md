# Codebase Retrieval Evaluations

Source: `scripts/eval_accuracy.js` (`npm run eval:accuracy`)  
Evaluates dense cosine vector search (`blobs.embedding <=> vector`, `bge-large` 1024-d) alongside full hybrid Reciprocal Rank Fusion (`search_code` / `searchBlobs` with dense rank + BM25 `tsv` rank + temporal decay).

| Date (UTC) | Corpus | Embedding Model | Method | Recall@1 | Recall@5 | Recall@10 | MRR |
|---|---|---|---|---|---|---|---|
| 2026-09-18 | `pg-git`, `krusch-context-mcp`, `krusch-cascade-router` (190 blobs) | `bge-large` (1024-d) | Dense Cosine | 5/10 (50.0%) | **10/10 (100.0%)** | **10/10 (100.0%)** | 0.717 |
| 2026-09-18 | `pg-git`, `krusch-context-mcp`, `krusch-cascade-router` (190 blobs) | `bge-large` (1024-d) | Hybrid RRF (`search_code`) | 5/10 (50.0%) | **10/10 (100.0%)** | **10/10 (100.0%)** | 0.717 |

---

### Benchmark Run Output

```text
🚀 Running Retrieval Accuracy Benchmark (Dense vs. Hybrid RRF)...

[1/10] Query: "priority queue for ollama inference fleet"
  - Dense Top Hit : llm-queue.js (Rank: 1)
  - Hybrid Top Hit: llm-queue.js (Rank: 1)

[2/10] Query: "database connection pool setup"
  - Dense Top Hit : scratch_query_activity.js (Rank: 2)
  - Hybrid Top Hit: SETUP.md (Rank: 1)

[3/10] Query: "codebase search with reciprocal rank fusion and bm25"
  - Dense Top Hit : git-engine.js (Rank: 1)
  - Hybrid Top Hit: EVALS.md (Rank: 2)

[4/10] Query: "episodic memory superseding and invalidation lifecycle"
  - Dense Top Hit : EPISODIC_MEMORY.md (Rank: 1)
  - Hybrid Top Hit: EPISODIC_MEMORY.md (Rank: 1)

[5/10] Query: "structural symbol and import extraction with regex"
  - Dense Top Hit : ast-chunker.js (Rank: 1)
  - Hybrid Top Hit: ast-chunker.js (Rank: 1)

[6/10] Query: "lakebase sqlite write-behind push sync"
  - Dense Top Hit : lakebase.test.js (Rank: 1)
  - Hybrid Top Hit: lakebase.test.js (Rank: 1)

[7/10] Query: "single-turn hybrid retrieval with token budget packing"
  - Dense Top Hit : EVALS.md (Rank: 2)
  - Hybrid Top Hit: EVALS.md (Rank: 2)

[8/10] Query: "proactive threat auditor and trajectory guardrails"
  - Dense Top Hit : README.md (Rank: 3)
  - Hybrid Top Hit: README.md (Rank: 3)

[9/10] Query: "steering nuggets memory persistence and nudges"
  - Dense Top Hit : README.md (Rank: 2)
  - Hybrid Top Hit: README.md (Rank: 2)

[10/10] Query: "postgresql git dag schema with pgvector embeddings"
  - Dense Top Hit : README.md (Rank: 3)
  - Hybrid Top Hit: TOOL_REFERENCE.md (Rank: 3)

===============================================================
                 RETRIEVAL EVALUATION RESULTS                  
===============================================================
Total Benchmark Queries : 10
---------------------------------------------------------------
Metric      | Dense Cosine (bge-large) | Hybrid RRF (search_code)
---------------------------------------------------------------
Recall@1    | 5/10 (50.0%)            | 5/10 (50.0%)
Recall@5    | 10/10 (100.0%)           | 10/10 (100.0%)
Recall@10   | 10/10 (100.0%)           | 10/10 (100.0%)
MRR         | 0.717                      | 0.717
===============================================================
```

---

### How to Reproduce

```bash
npm run eval:accuracy
```

### Evaluation Methodology & Caveats
- **Corpus Grounding**: Evaluates 10 technical architectural queries targeting actual source code and documentation within the indexed PostgreSQL Git DAG snapshot (`pg-git`, `krusch-context-mcp`, `krusch-cascade-router`).
- **Strict Target Matching**: Evaluates rank against primary implementation files and authoritative architectural documentation.
- **RRF vs. Cosine**: Dense retrieval computes vector similarity directly against `blobs.embedding`. Hybrid RRF fuses dense ranks with BM25 full-text match ranks on `blobs.tsv` and incorporates exponential temporal decay ($e^{-0.01t}$).
- **Single-Turn Retrieval Integration**: Full end-to-end single-turn retrieval (`krusch_context_retrieve`) additionally traverses $N$-hop relational symbol edges (`code_symbol_edges`) and packs Markdown context up to a specified token budget.
