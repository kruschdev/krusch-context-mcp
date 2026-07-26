# 🧠 The Deep Dive: Architecture, Inspiration, & Mechanics of `krusch-context-mcp`

> **Author**: Kevin (`kruschdev`)  
> **Date**: July 26, 2026  
> **Category**: `#SystemsArchitecture` `#AI` `#MCP` `#PostgreSQL` `#Polygres` `#OpenRouter` `#DeveloperTools`

![Unified AI Agent Working Memory Engine](/home/krusch/homelab/projects/krusch-context-mcp/docs/assets/krusch_context_mcp_spotlight.png)

> 💡 **Social Caption (247 chars)**:  
> *🧠 What makes krusch-context-mcp special? Unlike generic vector DBs, it unifies 5 core engines into 1 MCP process: Episodic Memory w/ recency decay, Holographic Steering, Company Brain v2, Lakebase SQLite sync & AI Watch research! 🚀*

---

## 💡 1. Inspiration & The Origin Story

### Why `krusch-context-mcp` Was Built
In early 2026, as AI coding assistants like Cursor, Claude Code, Windsurf, and Gemini CLI became central to daily development, a critical architectural gap emerged: **AI agents suffer from severe amnesia between sessions.**

Every new conversation started from a blank slate. Agents would:
1. Re-analyze the entire codebase repeatedly, wasting thousands of tokens.
2. Forget previous debugging breakthroughs and re-introduce bugs fixed days earlier.
3. Ignore project-specific architectural conventions (e.g. *"Always use ESM modules"*) unless manually re-prompted.

Traditional RAG tools (Pinecone, Qdrant, naive vector search) failed to solve this because they treated agent memory like a flat text index. They lacked **temporal awareness**, **steering capabilities**, **multi-agent consensus**, and **local offline capabilities**.

`krusch-context-mcp` was built to be the **sovereign, zero-trust, multi-engine working memory server** for the agent era.

---

## 🏗️ 2. How Local & Remote Agents Use the MCP Server

`krusch-context-mcp` exposes **42 standardized Model Context Protocol (MCP) tools** over stdio JSON-RPC transport. Any client — whether a cloud-hosted IDE like Cursor, a CLI agent like Claude Code, or a 100% offline local agent running via Ollama — connects seamlessly to the exact same memory server.

![5 Unified Memory Subsystems Architecture](/home/krusch/homelab/projects/krusch-context-mcp/docs/assets/krusch_context_mcp_5_subsystems_diagram.png)

### Key Architectural Strengths:
* **Local Agent Support**: Local agents get instant **sub-5ms zero-latency reads** from the project-scoped SQLite cache (`<project>/.agent/memory.db`). No internet connection required.
* **Cloud & Multi-Device Sync**: When connected online, write-behind sync automatically pushes local memories to durable **Polygres.com** PostgreSQL (`ide_agent_memory`, `ide_agent_nuggets`, `interaction_memory`).
* **Multi-Agent Consensus**: Multiple agents working on the same codebase share state in real-time. If Agent A fixes a bug, Agent B immediately inherits that lesson without re-auditing the code.

---

## 🌟 3. Deep Dive into the 5 Core Subsystems

### Subsystem 1: Episodic Memory & Temporal Recency Decay
Episodic memory records session learnings, past bugs, priorities, outcomes, and activity logs (`category: 'priorities' | 'bugs' | 'outcomes' | 'lessons' | 'activity'`).

Unlike flat vector search where a 6-month-old memory can distort current context, `krusch-context-mcp` applies **mathematical exponential decay**:

$$\text{FinalScore} = \text{Similarity} \times e^{-0.01 \times \text{age\_in\_days}}$$

* **Result**: A memory's relevance naturally decays ~26% after 30 days of inactivity. Recent refactors automatically supersede old decisions.

### Subsystem 2: Holographic Steering Nuggets
Prompt bloat degrades model reasoning. Rather than stuffing 2,000-line system prompts into every turn, **Holographic Nuggets** maintain lightweight key-value steering facts (`kind: 'project' | 'user' | 'agent'`).

* **Execution**: During planning turns, the agent queries `krusch_context_nugget_nudges({ query: "database setup" })`. The engine performs semantic vector search over key-values and injects micro-steering rules into context on-demand.

### Subsystem 3: Company Brain v2 (Multi-Agent Consensus & Provenance)
Designed for team collaboration and multi-agent coordination (`interaction_memory`):
* **Parent-Child Lineage**: Tracks memory ancestry (`parent_id`) so agents can audit version evolution.
* **Conflict Resolution**: `krusch_context_resolve_conflict({ conflict_ids, resolution_content })` allows agents to reach consensus when two memories contradict each other.
* **Role-Based Access Lenses**: `krusch_context_search_lens({ query, roles })` enforces read/write role authorization (`read_roles`, `write_roles`).

### Subsystem 4: Codebase Search & External Documentation Engine
* **Semantic Code Search**: Direct integration with `pg-git` indexes all source code blobs, git trees, commits, and branches into PostgreSQL.
* **External Manuals**: Ingests external documentation manuals (e.g. `polygres-docs`, `openrouter-docs`) so agents can query external specs via `krusch_docs_search`.

### Subsystem 5: Proactive Trajectory Auditor & AI Watch Research Engines
Integrates 4 cutting-edge AI research subsystems:
* **Proactive Auditor (`proactive_nudge`)**: Background auditor that inspects agent trajectories against past rules and failure patterns (OPD/PUST feedback loops).
* **AgentDebugX**: Real-time trajectory pattern matching against historical agent failure bundles (`agent_failure_bundles`).
* **DataFlow-Harness**: Pipeline DAG operator registries (`dataflow_operator_registry`).
* **Rubric4Setwise**: Setwise LLM-based reranking (`setwiseRerank`).
* **AREX**: Autonomous research constraint auditing and state tracking (`arex_research_states`).

---

## 🥊 4. Feature Comparison: `krusch-context-mcp` vs Alternatives

| Feature | Generic Vector DBs | Naive MCP Memory | `krusch-context-mcp` |
| :--- | :---: | :---: | :---: |
| **Protocol Support** | Proprietary REST | MCP | **Native 42-Tool MCP Surface** |
| **Temporal Recency Decay** | ❌ No | ❌ No | **✅ Exponential Decay ($e^{-0.01t}$)** |
| **Micro-Steering (Nuggets)** | ❌ No | ❌ No | **✅ Holographic Steering Facts** |
| **Multi-Agent Consensus** | ❌ No | ❌ No | **✅ Company Brain v2 Substrate** |
| **Graph-Vector Fusion** | Separate DB | ❌ No | **✅ Native `pgGraph` Multi-Hop Walks** |
| **Offline Cache + Cloud Sync** | ❌ No | Local Only | **✅ SQLite Cache + Polygres.com Sync** |
| **Failure Pattern Matching** | ❌ No | ❌ No | **✅ Native AgentDebugX Integration** |

---

## ⚙️ 5. Deployment & Configuration

`krusch-context-mcp` supports 100% local, 100% cloud, or hybrid deployment:

```env
# --- Polygres.com Cloud Database & Runtime API ---
POLYGRES_PROJECT_ID="p4b2ef196c33edbd8be43174"
POLYGRES_RUNTIME_URL="https://p4b2ef196c33edbd8be43174.api.db.polygres.com/v1"
POLYGRES_API_KEY="poly_live_YOUR_POLYGRES_API_KEY"

# Native PostgreSQL Connection
DATABASE_URL="postgresql://username:password@app.polygres.com:5432/kruschdb?sslmode=require"

# --- OpenRouter Cloud Embeddings (baai/bge-large-en-v1.5) ---
EMBEDDING_URL="https://openrouter.ai/api/v1/embeddings"
EMBEDDING_API_KEY="sk-or-v1-YOUR_OPENROUTER_API_KEY"
EMBED_MODEL="baai/bge-large-en-v1.5"
```

---

# 📋 X Articles Clean Copy-Paste Version (No Markdown Syntax Punctuation)

Title:
The Deep Dive: Architecture, Inspiration, & Mechanics of krusch-context-mcp

Subtitle:
By Kevin Ruschman (kruschdev) • July 26, 2026

Inspiration & The Origin Story

In early 2026, as AI coding assistants like Cursor, Claude Code, Windsurf, and Gemini CLI became central to daily development, a critical architectural gap emerged: AI agents suffer from severe amnesia between sessions. Every new conversation started from a blank slate.

Traditional RAG tools (Pinecone, Qdrant, naive vector search) failed to solve this because they treated agent memory like a flat text index. They lacked temporal awareness, steering capabilities, multi-agent consensus, and local offline capabilities. krusch-context-mcp was built to be the sovereign, zero-trust, multi-engine working memory server for the agent era.

How Local & Remote Agents Use the MCP Server

[INSERT IMAGE: /home/krusch/Pictures/krusch_context_mcp_5_subsystems_diagram.png]

krusch-context-mcp exposes 42 standardized Model Context Protocol (MCP) tools over stdio JSON-RPC transport. Any client — whether a cloud-hosted IDE like Cursor, a CLI agent like Claude Code, or a 100% offline local agent running via Ollama — connects seamlessly to the exact same memory server.

• Local Agent Support: Local agents get instant sub-5ms zero-latency reads from the project-scoped SQLite cache. No internet connection required.

• Cloud & Multi-Device Sync: When connected online, write-behind sync automatically pushes local memories to durable Polygres.com PostgreSQL.

• Multi-Agent Consensus: Multiple agents working on the same codebase share state in real-time. If Agent A fixes a bug, Agent B immediately inherits that lesson.

Deep Dive into the 5 Core Subsystems

1. Episodic Memory & Temporal Recency Decay: Applies exponential decay so recent architectural decisions automatically supersede stale historical workarounds without requiring manual deletion.

2. Holographic Steering Nuggets: Maintains lightweight key-value steering facts to steer model behavior dynamically without polluting system prompts.

3. Company Brain v2: Multi-agent consensus, parent-child versioning, conflict resolution, and role-based access lenses.

4. Codebase & Docs Search: Indexes source code blobs, git trees, commits, and external documentation manuals.

5. AI Watch Research Engines: Integrates AgentDebugX failure pattern matching, DataFlow DAG operator registries, Rubric4Setwise reranking, and AREX constraint auditing.

Links & Resources

• GitHub Repository: https://github.com/kruschdev/krusch-context-mcp
• Tool Reference: https://github.com/kruschdev/krusch-context-mcp/blob/main/docs/TOOL_REFERENCE.md
• Polygres Platform: https://polygres.com
• OpenRouter Embeddings: https://openrouter.ai
