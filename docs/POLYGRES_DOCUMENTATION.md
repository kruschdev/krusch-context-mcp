# Polygres Official Documentation & RAG Knowledge Base

> **Source**: [Evokoa Polygres Docs](https://docs.evokoa.com/polygres)  
> **Ingested**: 2026-07-21  
> **License**: Apache-2.0  
> **Repository**: [Evokoa/polygres-sdk](https://github.com/Evokoa/polygres-sdk)

---

## 1. Overview & What is Polygres?

**Polygres** is an all-in-one database platform and SDK built on managed PostgreSQL, designed specifically to serve as working memory for AI agents. It combines relational database tables, native graph traversal (`pgGraph`), and HNSW vector similarity search (`pgvector`/`pgContext`) into a unified retrieval engine.

### Key Value Proposition
* **No Data Movement / Single Engine**: Relational data, graph relationships, and vector embeddings reside within the same PostgreSQL instance. Context retrieval is a database query rather than a complex multi-service ETL pipeline.
* **Unified Retrieval API**: Exposes single-query hybrid search (`polygres.retrieve()`) combining scalar SQL filters, multi-hop graph walks, and vector similarity search.
* **Token Budget Packing**: Automatically ranks, truncates, and formats context blocks to fit strictly within specified model context budgets (`limit_tokens`).

---

## 2. Key Concepts & Architecture

### Three Memory Layers in One Instance
1. **Structured Records**: Relational SQL tables representing ground-truth entities (users, orders, transactions).
2. **Connected Relationships (`pgGraph`)**: Graph edges enabling multi-hop relationship traversals (e.g., `Order -> Payment -> Dispute -> User`).
3. **Semantic Recall (`pgvector` / `pgContext`)**: Fast HNSW approximate nearest neighbor (ANN) vector indexing for semantic text matching.

---

## 3. Quickstart & Integration

### Python SDK Setup
```bash
pip install polygres-sdk
```

### Basic Initialization & Connection
```python
from polygres import PolygresClient

# Initialize client with Polygres Cloud or Self-Hosted connection string
client = PolygresClient(
    connection_string="postgresql://user:password@app.polygres.com:5432/your_database",
    api_key="your_polygres_api_key"
)
```

### Hybrid Context Retrieval Example (`polygres.retrieve`)
```python
# Hybrid query combining vector similarity, graph walks, scalar filters, and token packing
context_payload = client.retrieve(
    query="Why did order #8231 fail?",
    graph_hops=2,                 # Traverse 2 hops: orders → payments → disputes
    filters={"status": "failed"}, # Scalar SQL filters
    limit_tokens=8000,            # Hard token budget for context block
    include_embeddings=True
)

# Inject packed context block into LLM completion
response = agent.run(context_payload.markdown)
```

---

## 4. Features & SDK Capabilities

### Multi-Hop Graph Walks (`graph_hops`)
* `graph_hops=0`: Pure vector ANN similarity search on primary target nodes.
* `graph_hops=1`: Expands 1st-degree relational edges (e.g. Memory -> Referenced File).
* `graph_hops=2`: Expands 2nd-degree relational edges (e.g. Memory -> Referenced File -> Related Unit Test / Bug Log).

### Token Budget Management (`limit_tokens`)
* Ranks results using `FinalScore = (Similarity * RecencyDecay) + GraphProximityBonus`.
* Iteratively packs items until hitting `limit_tokens` ceiling to prevent context window overflow.

### Platform & Deployment Options
* **Self-Hosted Mode**: Run local PostgreSQL + `pgvector` / `pgGraph` with open-source `polygres-sdk` (Apache-2.0).
* **Managed Polygres Cloud**: Hosted zero-maintenance cloud database platform at [app.polygres.com](https://app.polygres.com).

---

## 5. Krusch Context MCP & PG-Git Integration

`krusch-context-mcp` serves as the flagship implementation of Polygres working memory principles for AI coding agents, natively unifying **Episodic Memory**, **Holographic Steering**, and the **[PG-Git](https://github.com/kruschdev/pg-git)** codebase engine into a single PostgreSQL substrate.

### Three-Layer Agent Memory Map
| Polygres Layer | Krusch Context & PG-Git Implementation | Storage Tables |
|----------------|----------------------------------------|----------------|
| **1. Structured Records** | Git DAG, commits, branches, repository metadata, steering facts | `repositories`, `commits`, `branches`, `ide_agent_nuggets` |
| **2. Connected Relationships (`pgGraph`)** | Multi-hop AST symbol calls/imports, memory-to-blob edges, version ancestry | `code_symbol_edges`, `memory_to_blob_edges`, `interaction_memory(parent_id)` |
| **3. Semantic Recall (`pgvector` / `pgContext`)** | HNSW index vector matching with exponential temporal decay ($e^{-0.01t}$) | `blobs(embedding)`, `code_symbols`, `ide_agent_memory` |

### Unified Hybrid Retrieval (`krusch_context_retrieve`)
Implements the `polygres.retrieve()` paradigm as an MCP tool:
```javascript
// Single-call hybrid retrieval over episodic memory + PG-Git codebase DAG
krusch_context_retrieve({
  query: "How does the connection pool handle transaction rollbacks?",
  project: "krusch-context-mcp",
  graph_hops: 2,       // Walk memory -> blob -> AST callers/callees
  limit_tokens: 4000,  // Server-side context packing
  include_code: true   // Include PG-Git blobs and symbols
});
```

### Shared Schema Synergy with Standalone PG-Git
Both `krusch-context-mcp` and the standalone [PG-Git](https://github.com/kruschdev/pg-git) (`pg-git-mcp@1.1.0`) package share this identical PostgreSQL data layer. Whether running locally or deployed on managed **Polygres Cloud** (`app.polygres.com`), the same database instance simultaneously powers single-purpose codebase RAG and full multi-agent context orchestration without data duplication.

