# Codebase Retrieval Evaluations

Source: `scripts/eval_accuracy.js` (`npm run eval:accuracy`)  
Evaluates retrieval accuracy across a 3-way ablation:
1. **BM25 Lexical Search**: PostgreSQL full-text scoring (`ts_rank_cd` on `blobs.tsv`)
2. **Dense Vector Retrieval**: Cosine similarity on 1024-d embeddings (`bge-large`, `blobs.embedding <=> vector`)
3. **Hybrid Reciprocal Rank Fusion (RRF)**: `krusch-context-mcp`'s core [`search_code`](../src/git-engine.js) fusing dense ranks, BM25 keyword ranks, and exponential temporal decay ($e^{-0.01 \cdot \text{age}}$)

---

## 3-Way Ablation Benchmark Summary

| Date (UTC) | Corpus | Method | Recall@1 | Recall@5 | Recall@10 | MRR | Code Identifiers R@1 |
|---|---|---|---|---|---|---|---|
| 2026-09-18 | `pg-git`, `krusch-context-mcp`, `krusch-cascade-router` (190 blobs) | **BM25 Lexical** (Postgres `ts_rank_cd`) | 3/14 (21.4%) | 4/14 (28.6%) | 4/14 (28.6%) | 0.238 | 2/6 (33.3%) |
| 2026-09-18 | `pg-git`, `krusch-context-mcp`, `krusch-cascade-router` (190 blobs) | **Dense Cosine** (`bge-large` 1024-d) | 11/14 (78.6%) | **14/14 (100.0%)** | **14/14 (100.0%)** | 0.881 | 4/6 (66.7%) |
| 2026-09-18 | `pg-git`, `krusch-context-mcp`, `krusch-cascade-router` (190 blobs) | **Hybrid RRF** (`search_code`) | **13/14 (92.9%)** | **14/14 (100.0%)** | **14/14 (100.0%)** | **0.964** | **6/6 (100.0%)** |

---

### Benchmark Run Output

```text
🚀 Running 3-Way Retrieval Accuracy Benchmark (BM25 vs. Dense vs. Hybrid RRF)...

[1/14] [SEMANTIC] Query: "priority queue for ollama inference fleet"
  - BM25   Top Hit : llm-queue.js (Rank: 1)
  - Dense  Top Hit : llm-queue.js (Rank: 1)
  - Hybrid Top Hit : llm-queue.js (Rank: 1)

[2/14] [SEMANTIC] Query: "database connection pool setup"
  - BM25   Top Hit : eval_accuracy.js (Rank: 3)
  - Dense  Top Hit : scratch_query_activity.js (Rank: 2)
  - Hybrid Top Hit : SETUP.md (Rank: 1)

[3/14] [SEMANTIC] Query: "episodic memory superseding and invalidation lifecycle"
  - BM25   Top Hit : No match (Rank: Miss)
  - Dense  Top Hit : EPISODIC_MEMORY.md (Rank: 1)
  - Hybrid Top Hit : EPISODIC_MEMORY.md (Rank: 1)

[4/14] [SEMANTIC] Query: "proactive threat auditor and trajectory guardrails"
  - BM25   Top Hit : No match (Rank: Miss)
  - Dense  Top Hit : README.md (Rank: 1)
  - Hybrid Top Hit : README.md (Rank: 1)

[5/14] [SEMANTIC] Query: "single-turn hybrid retrieval with token budget packing"
  - BM25   Top Hit : No match (Rank: Miss)
  - Dense  Top Hit : EVALS.md (Rank: 1)
  - Hybrid Top Hit : EVALS.md (Rank: 1)

[6/14] [SEMANTIC] Query: "lakebase sqlite write-behind push sync"
  - BM25   Top Hit : No match (Rank: Miss)
  - Dense  Top Hit : lakebase.test.js (Rank: 1)
  - Hybrid Top Hit : lakebase.test.js (Rank: 1)

[7/14] [SEMANTIC] Query: "steering nuggets memory persistence and nudges"
  - BM25   Top Hit : No match (Rank: Miss)
  - Dense  Top Hit : README.md (Rank: 1)
  - Hybrid Top Hit : README.md (Rank: 1)

[8/14] [SEMANTIC] Query: "postgresql git dag schema with pgvector embeddings"
  - BM25   Top Hit : No match (Rank: Miss)
  - Dense  Top Hit : README.md (Rank: 1)
  - Hybrid Top Hit : TOOL_REFERENCE.md (Rank: 2)

[9/14] [SYMBOLIC] Query: "astChunker balanced brace"
  - BM25   Top Hit : No match (Rank: Miss)
  - Dense  Top Hit : embedding.js (Rank: 2)
  - Hybrid Top Hit : ast-chunker.js (Rank: 1)

[10/14] [SYMBOLIC] Query: "CVE-2026-13676 fast-uri"
  - BM25   Top Hit : CHANGELOG.md (Rank: 1)
  - Dense  Top Hit : pr-evaluation.yml (Rank: 3)
  - Hybrid Top Hit : CHANGELOG.md (Rank: 1)

[11/14] [SYMBOLIC] Query: "KRUSCH_PROFILE extended"
  - BM25   Top Hit : AGENTS.md (Rank: 1)
  - Dense  Top Hit : index.js (Rank: 1)
  - Hybrid Top Hit : AGENTS.md (Rank: 1)

[12/14] [SYMBOLIC] Query: "detectCurrentProject git rev-parse"
  - BM25   Top Hit : No match (Rank: Miss)
  - Dense  Top Hit : project-helper.js (Rank: 1)
  - Hybrid Top Hit : project-helper.js (Rank: 1)

[13/14] [SYMBOLIC] Query: "routeSkills diverse skills"
  - BM25   Top Hit : No match (Rank: Miss)
  - Dense  Top Hit : skills-engine.js (Rank: 1)
  - Hybrid Top Hit : skills-engine.js (Rank: 1)

[14/14] [SYMBOLIC] Query: "evaluateResilience credential leaks"
  - BM25   Top Hit : No match (Rank: Miss)
  - Dense  Top Hit : research-tools.test.js (Rank: 1)
  - Hybrid Top Hit : research-tools.test.js (Rank: 1)

===================================================================================
                     3-WAY RETRIEVAL ABLATION RESULTS                              
===================================================================================
Total Benchmark Queries : 14 (8 Semantic Concepts + 6 Code Identifiers)
-----------------------------------------------------------------------------------
Metric      | BM25 Lexical (Postgres)  | Dense Cosine (bge-large) | Hybrid RRF (search_code)
-----------------------------------------------------------------------------------
Recall@1    | 3/14 (21.4%)             | 11/14 (78.6%)            | 13/14 (92.9%)
Recall@5    | 4/14 (28.6%)             | 14/14 (100.0%)           | 14/14 (100.0%)
Recall@10   | 4/14 (28.6%)             | 14/14 (100.0%)           | 14/14 (100.0%)
MRR         | 0.238                    | 0.881                    | 0.964
-----------------------------------------------------------------------------------
CATEGORY BREAKDOWN (Recall@1):
- Semantic Concepts (8) : BM25: 12.5% | Dense: 87.5% | Hybrid: 87.5%
- Code Identifiers  (6) : BM25: 33.3% | Dense: 66.7% | Hybrid: 100.0%
===================================================================================
```

---

### Why Hybrid Outperforms Dense and BM25

1. **Semantic Queries (Conceptual Architecture)**:
   - Queries like *"priority queue for ollama inference fleet"* or *"lakebase sqlite write-behind push sync"* describe system intent in natural language.
   - BM25 alone performs poorly (12.5% Recall@1) because the exact words are rarely in the code comments.
   - Dense vector search shines here (87.5% Recall@1). Hybrid RRF preserves 100% of this semantic power.

2. **Symbolic / Code Queries (Exact Identifiers and Tokens)**:
   - Queries like `"astChunker balanced brace"` or `"CVE-2026-13676 fast-uri"` search for specific function names, vulnerability CVE IDs, or configuration flags.
   - Dense models struggle with token novelty: dense vector search ranked `embedding.js` higher than `ast-chunker.js` (Rank 2) and ranked `pr-evaluation.yml` higher than `CHANGELOG.md` (Rank 3).
   - BM25 full-text indexing locks directly onto exact tokens. Fusing the two via RRF elevates exact identifier **Recall@1 from 66.7% (Dense) to 100.0% (Hybrid)**.

3. **Overall Impact**:
   - Hybrid RRF delivers **92.9% Recall@1** and **0.964 MRR** across the entire corpus, providing reliable top-1 accuracy for LLM agents with constrained context budgets.

---

### How to Reproduce

```bash
npm run eval:accuracy
```
