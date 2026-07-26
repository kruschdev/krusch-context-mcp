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
    connection_string="postgresql://user:password@app.polygres.com:5432/krusch_nexus_db",
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
