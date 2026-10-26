# 🧠 What Makes `krusch-context-mcp` Special

> **Author**: Kevin (`kruschdev`)  
> **Version**: v1.9.0  
> **Category**: `#AI` `#MCP` `#DeveloperTools` `#AgentArchitecture` `#SQLite` `#NodeJS`

![Unified AI Agent Working Memory Engine](assets/krusch_context_mcp_spotlight.png)

> 💡 **Social Caption**:  
> *Most agent memory tools dump unstructured notes into a flat vector bag and rot within a week. What makes krusch-context-mcp v1.9.0 special? A radical 5-verb contract, closed taxonomy, span-grounded provenance with drift self-healing, temporal lineage, Porter FTS5 + 8K-context `snowflake-arctic-embed2` binary `Float32Array` vectors on zero-Docker SQLite, and pre-commit invariant steering.*

---

## 1. The Core Problem: The "Goldfish Agent" and the Bag of Notes

AI coding assistants (Cursor, Claude Code, Windsurf, Codex) are brilliant in short bursts, but they suffer from **cross-session amnesia**:
1. **Goldfish Sessions**: Every turn or prompt restart forgets why architectural compromises were made.
2. **Zombie Regressions**: A bug diagnosed and patched three days ago is reintroduced because the agent forgot the root cause.
3. **Convention Amnesia**: Critical invariants (*"Never use raw SQL queries without parameterized bindings"*, *"Always return RFC 7807 error envelopes"*) must be repeatedly re-explained.

### The Naive Solution That Fails: The "Bag of Notes"
Most memory MCP servers attempt to solve this by creating an unbounded vector store where the agent writes random unconstrained notes (`remember("User prefers red buttons")`).

Within a week, this breaks down:
* **Memory Rot**: A note from two months ago (*"Use temporary in-memory mock"*) contradicts current production architecture (*"Use PostgreSQL"*) and poisons the agent's context.
* **Tool Soup**: Servers exposing 15 to 60+ tools overwhelm the LLM's context window with tool schemas, causing frequent hallucinated parameters and degraded reasoning.
* **No Accounting for Change**: When a decision changes, naive stores either overwrite history blindly (destroying context) or let contradictory notes coexist without explanation.

---

## 2. What Makes `krusch-context-mcp` Special in v1.9.0

`krusch-context-mcp` rejects the flat note-bag pattern. Instead, it treats agent memory as a **structured, governed lifecycle**:

```mermaid
graph TD
    A["Session Start"] --> B["1. retrieve(include_state: true)"]
    B --> C["Work & Architecture"]
    C --> D["2. remember(category: closed)"]
    D --> E{"Near Duplicate? (cos >= 0.85)"}
    E -->|Yes| F["Suggest revise(supersede)"]
    E -->|No| G["Persist with Lineage"]
    G --> H["3. nudge(trigger: pre_commit)"]
    H --> I["Commit & Hygiene"]
    I --> J["4. revise(invalidate + reason)"]
    I --> K["5. health(stats + decay review)"]
```

---

### Pillar 1: The 5-Verb Discipline (Eliminating Tool Soup)

Most MCP servers suffer from bloated tool definitions. Exposing dozens of tools costs 3,000+ tokens *on every turn* and confuses the agent.

`krusch-context-mcp` enforces a tight, ergonomic surface of **strictly five canonical verbs**:

| Verb | Tool Name | Purpose |
| :--- | :--- | :--- |
| **`retrieve`** | `krusch_context_retrieve` | Hydrate working context & state briefings within an exact token budget. |
| **`remember`** | `krusch_context_remember` | Store lasting decisions or key-value steering nuggets with near-dup guards. |
| **`revise`** | `krusch_context_revise` | Supersede old decisions with lineage links, or invalidate with mandatory justification. |
| **`nudge`** | `krusch_context_nudge` | Audit code diffs against recorded invariants before committing (max 1–3 findings). |
| **`health`** | `krusch_context_health` | Inspect taxonomy breakdown, storage mode, and review memories older than 30 days. |

*Result*: Tool schema footprint is reduced from ~3,500 tokens to **~350 tokens**. Host agents call the right tool with near-100% precision.

---

### Pillar 2: The Closed Write Taxonomy

Unconstrained text dumps quickly degenerate into garbage. `krusch-context-mcp` requires every memory to declare a valid category from a closed taxonomy:

* **`decision`**: Architectural commitments and trade-offs (*"Standardized on node:sqlite built-in over better-sqlite3"*).
* **`invariant`**: Non-negotiable code rules enforced during pre-commit (*"All HTTP API errors must use RFC 7807 envelopes"*).
* **`bug`**: Diagnosed root causes and anti-regression rules (*"WAL checkpoint deadlock occurs when concurrent writer runs without mutex"*).
* **`lesson`**: Framework discoveries and operational quirks (*"Vite 5 requires ESM output when targeting Node 22"*).
* **`blocker`**: External dependencies or pending upstream migrations.

Because every entry is classified, `retrieve({ include_state: true })` can instantly construct an organized project briefing in a single turn.

---

### Pillar 3: Temporal Lineage & Audited Invalidation

When architectural decisions evolve, naive systems overwrite or leave stale twins. `krusch-context-mcp` maintains an explicit temporal lineage:

1. **Near-Duplicate Warning**: When calling `remember`, if a new memory matches an existing record (`cosine >= 0.85`), the server warns the agent and returns the candidate ID:
   ```json
   {
     "warning": "near_duplicate",
     "candidate_id": 14,
     "suggestion": "Call revise with action 'supersede' if updating this knowledge."
   }
   ```
2. **Superseding**: Calling `revise(action: 'supersede', target_id: 14)` marks the previous record `SUPERSEDED` and records `supersedes_id: 14` on the new record. Active queries only see the latest truth, but historical lineage is preserved.
3. **Mandatory Invalidation Justification**: When retiring a rule or invariant, `revise(action: 'invalidate')` strictly rejects empty reasons:
   ```json
   {
     "action": "invalidate",
     "target_id": 8,
     "reason": "Replaced manual mutex with atomic SQLite transactions in v1.8."
   }
   ```
   Agents can inspect *why* a historical rule was deprecated, preventing teams from repeating past debates.

---

### Pillar 4: Token-Budgeted State Packing

Agents operate under finite context budgets. Asking an agent to read a sprawling memory store causes prompt overflow.

`krusch_context_retrieve` accepts a `limit_tokens` budget (default: 4,000 tokens) and performs greedy pack reranking:
1. Active Project Invariants (highest priority)
2. Unresolved Blockers & Recent Decisions
3. Ranked Semantic Matches
4. Decay Candidates (>30 days old) flagged for review

In one turn at session start, the agent is fully grounded in the project's living context without wasting tokens.

---

### Pillar 5: Zero-Docker, Zero-Native-Compilation Local First

`krusch-context-mcp` requires **zero Docker containers, zero external database setup, and zero native compilation** (`better-sqlite3`, `ml-pca`, and `@opentelemetry/*` were eliminated):

* **Native Node 22 SQLite**: Leverages built-in `node:sqlite` (`DatabaseSync`) to persist data to `.agent/context.db` right next to your repository.
* **Instant Setup**:
  ```bash
  npx krusch-context-mcp init
  ```
  Initializes `.agent/context.db`, configures `.env`, seeds the starter project invariant, installs `AGENTS.md`, and prints copy-paste configurations for Cursor and Claude Code in under 5 seconds.
* **Operational Honesty**: If an Ollama embedding daemon is available, it uses `8,192`-context dense vector similarity (`snowflake-arctic-embed2` @ `1024`-d, stored as compact `4 KB` binary `Float32Array` blobs with asymmetric `query:` retrieval). If no embedding service is running, it seamlessly falls back to Porter-stemmed `FTS5` lexical search, recency scoring, and tag indexing without crashing.
* **Optional Fleet Adapter**: For multi-machine homelab fleets, setting `STORAGE_MODE=postgres` connects to PostgreSQL + `pgvector` with zero code changes.

---

## 3. Why Was Codebase RAG Separated Into `krusch-git`?

Earlier versions of `krusch-context-mcp` attempted to bundle everything into a single package: AST code parsing, Git commit DAG traversal, symbol call graphs, external documentation, and decision memory.

In v1.8.0, **Codebase RAG was decoupled into [krusch-git](https://github.com/kruschdev/krusch-git)** (`krusch-git@1.2.2`).

### The Architectural Rationale:
1. **Divergent Lifecycles**:
   - **Code Structure (`krusch-git`)** changes with every git commit, branch checkout, or file edit. It requires AST parsers, commit graph walkers, and symbol edge extractors.
   - **Decision Memory (`krusch-context-mcp`)** changes with human/agent architectural commitments, debugging discoveries, and policy shifts.
2. **Preventing Agent Confusion**:
   Combining code search (`search_code`, `search_symbols`, `symbol_graph`) with memory verbs in the same MCP tool table led agents to call code search when they needed memory, or vice versa.
3. **The Sibling Synergy**:
   - Use **`krusch-context-mcp`** (Tier 1) for **Agent Steering & Episodic Memory** (why code was written).
   - Use **`krusch-git`** (Tier 2) for **Git DAG & Symbol Traversal** (how code is structured).
   - Use **`krusch-harness`** (Tier 3) for **Staged Execution & Verification** (how code is safely committed).

### The 7 Canonical Tools of `krusch-git`:
| Tool | Purpose |
|---|---|
| `krusch_git_list_repos` | List all indexed repositories & branch metadata |
| `krusch_git_read_tree` | Inspect Git DAG tree hierarchy at commit/branch |
| `krusch_git_read_blob` | Fetch content-addressed file blob or pointer file |
| `krusch_git_semantic_search` | Hybrid cosine + BM25 + temporal recency decay ($e^{-0.01t}$) |
| `krusch_git_search_symbols` | AST lookup for functions, classes, and Markdown sections |
| `krusch_git_file_symbols` | Line-range symbol map for a specific file |
| `krusch_git_dependency_graph` | Multi-hop caller/callee traversal around target symbol |

---

### The 3-Tier Coding Agent MCP Ecosystem

```
┌─────────────────────────────────────────────────────────────┐
│ 1. SESSION START & INVARIANTS                               │
│    krusch-context-mcp: retrieve, remember, revise, nudge     │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. CODE EXPLORATION & ARCHITECTURE                          │
│    krusch-git: search_symbols, dependency_graph, read_blob   │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. STAGED EXECUTION & VERIFICATION                          │
│    krusch-harness: run, task_status, diff, apply_diff        │
└─────────────────────────────────────────────────────────────┘
```

---

## 4. Feature Comparison: The Evolution

| Capability | Generic Vector DB | Naive MCP Memory | krusch-context-mcp v1.9.0 |
| :--- | :---: | :---: | :---: |
| **Tool Count** | REST APIs / 10+ | 8–20 tools | **Strictly 5 Canonical Verbs** (~350 schema tokens) |
| **Write Model** | Raw vectors | Unbounded strings | **Closed Taxonomy** (`decision`, `invariant`, `bug`, etc.) |
| **Memory Lineage** | ❌ None | ❌ Overwrite | **✅ Supersede pointers + mandatory invalidation reason** |
| **Span-Grounded Provenance** | ❌ None | ❌ None | **✅ `INV-12` `quoted_sentence` hash + line self-healing & drift flags** |
| **Near-Duplicate Guard** | ❌ None | ❌ None | **✅ Cosine >= 0.85 warning + candidate suggestion** |
| **Pre-Commit Audit** | ❌ None | ❌ None | **✅ `nudge` diff check (max 1–3 high-signal findings)** |
| **Local Storage & Vectors** | Docker / SaaS | JSON text / native build | **✅ Node 22 `node:sqlite` + Porter `FTS5` + `4 KB` `Float32Array` blobs** |
| **Default Local Embedder** | External API | 512-ctx symmetric | **✅ `snowflake-arctic-embed2` (`8,192` ctx, `1024d`, asymmetric `query:`)** |
| **Embeddings Fallback** | Hard crash | None | **✅ Graceful degradation to FTS5 lexical + recency** |
| **Agent Protocol Enforcement** | Manual prompt | Manual prompt | **✅ Automated `AGENTS.md` installer in `init`** |

---

## 5. Empirical Validation: Complete Official ICLR 2026 BEAM Suite (`100K`–`10M`, `n = 2,000/2,000` Closed-System G4)

To verify retrieval and reasoning performance without self-grading bias, cloud APIs, or benchmark gaming, `krusch-context-mcp` (`v1.9.0`, SQLite `Float32Array` `embedding_blob` + Porter `FTS5` + `snowflake-arctic-embed2:latest`) was evaluated across **all `100` multi-session conversations (`163,559` turns, `~178.34M` corpus tokens) and all `2,000/2,000` validated probing questions** of the official ICLR 2026 **`Mohammadta/BEAM`** (`100K`, `500K`, `1M`) and **`Mohammadta/BEAM-10M`** (`10M`) suite inside a hermetic single-box **96 GB NVIDIA RTX PRO 6000 Blackwell** environment (`127.0.0.1:11434` loopback only, fresh cold-room embeddings, zero oracle leakage enforced by [`benchmarks/verify_zero_leakage.js`](../benchmarks/verify_zero_leakage.js) and [`benchmarks/verify_zero_leakage_long.js`](../benchmarks/verify_zero_leakage_long.js)):

| Metric / Evaluation Track (`~8K` Constant Budget) | Baseline / Reference | `krusch-context-mcp v1.9.0` (`snowflake-arctic-embed2` `8K` ctx) |
| :--- | :---: | :---: |
| **`100K` Split (`n = 400/400`, `20` convs, `~3.06M` tok)** | `30.74%` Lex 8K · `92.41%` Dense 8K<br>`Honcho` (`63.00%`) · `MEMIR` (`48.26%`) | **`92.37%` Hybrid 8K** (`57.69%` `R@10`; `92.97%` `bge-large` ablation)<br>**`70.60%`** (`hermes3:latest`) / **`64.26%`** (`qwen2.5:32b`) E2E QA |
| **`500K` Split (`n = 700/700`, `35` convs, `~19.40M` tok)** | `6.55%` Lex 8K · `78.81%` Dense 8K | **`81.51%` Hybrid 8K** (**`+2.70 pp`** vs. Dense; `12.67%` of conv packed)<br>**`71.82%`** (`hermes3:latest`) / **`62.31%`** (`qwen2.5:32b`) E2E QA |
| **`1M` Split (`n = 700/700`, `35` convs, `~40.02M` tok)** | `0.70%` Lex 8K · `72.24%` Dense 8K | **`74.15%` Hybrid 8K** (**`+1.91 pp`** vs. Dense; `6.69%` of conv packed)<br>**`72.86%`** (`hermes3:latest`) / **`64.64%`** (`qwen2.5:32b`) E2E QA |
| **`10M` Split (`n = 200/200`, `10` convs, `~115.87M` tok)** | `0.00%` Lex 8K · `53.51%` Dense 8K | **`54.78%` Hybrid 8K** (**`+1.27 pp`** vs. Dense; `88.00%` `IE`, `83.75%` `KU`; `0.66%` packed)<br>**`58.78%`** (`hermes3:latest`) / **`47.35%`** (`qwen2.5:32b`) E2E QA |
| **Grand Total (`n = 2,000/2,000` Qs, `~178.34M` tok)** | `8.71%` Lex 8K · `76.88%` Dense 8K | **`78.67%` Hybrid 8K** (**`+1.79 pp`** vs. Dense while packing `~8.4` fewer turns)<br>**`70.64%`** (`hermes3:latest`) / **`62.02%`** (`qwen2.5:32b`) E2E (`83.10%` agree) |
| **Contradiction Resolution Across All 4 Splits** | `past.dev`: `78.13 / 78.57 / 75.36 / 73.13%` | **Beats `past.dev` on all 4 splits**: `92.50 / 89.64 / 77.68 / 78.75%` (`hermes3`)<br>`85.94 / 81.79%` Stock `32B` (`100K`/`500K`) · **`98.13%`** ([`gpt-oss-120b-sre-lora`](https://huggingface.co/krush420/gpt-oss-120b-sre-lora) `100K`) |
| **Upstream Canary Trap & Zero-Gaming Gates** | `0.00` = Blind / Un-Gamed | **`0.00` (`5/5` integrity checks passed across `100K`, `500K`, `1M`, `10M`)** |

See the full methodology, SHA-256 digests, Dual Cross-Family Judge breakdown, `calibrateQuerySimilarity` calibration analysis, Stock vs. QLoRA `120B` ablation, and Section 8 multi-split tables in [`benchmarks/BEAM_EMPIRICAL_REPORT.md`](../benchmarks/BEAM_EMPIRICAL_REPORT.md).

---

## 6. Quickstart

Get persistent, self-governing memory in any repository:

```bash
# In your project repository:
npx krusch-context-mcp init
```

Add to your **Cursor** (`.cursor/mcp.json`):
```json
{
  "mcpServers": {
    "krusch-context": {
      "command": "npx",
      "args": ["-y", "krusch-context-mcp"]
    }
  }
}
```

Or **Claude Code**:
```bash
claude mcp add krusch-context npx krusch-context-mcp
```

Your agent will automatically read `AGENTS.md`, hydrate its state with `retrieve`, record enduring lessons with `remember`, audit diffs with `nudge`, and keep context pristine.
