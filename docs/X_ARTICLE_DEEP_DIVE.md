# 📄 X Article Ready Copy-Paste: The Deep Dive into `krusch-context-mcp`

> 💡 **Instructions for X Articles**: Copy the text in the box below directly into the X Articles editor on X.com (desktop). Click **Add Cover** and pick `/home/krusch/Pictures/krusch_context_mcp_spotlight.png`. Under Section 3, click **+ (Add Media)** and insert `/home/krusch/Pictures/krusch_context_mcp_5_subsystems_diagram.png`. This copy has **zero raw Markdown syntax clutter**!

---

Title:
The Deep Dive: Architecture, Inspiration, & Mechanics of krusch-context-mcp

Subtitle:
By Kevin Ruschman (kruschdev) • July 26, 2026

1. Inspiration & The Origin Story

In early 2026, as AI coding assistants like Cursor, Claude Code, Windsurf, and Gemini CLI became central to daily software development, a critical architectural gap emerged: AI agents suffer from severe amnesia between sessions.

Every new conversation started from a blank slate. Agents would re-analyze the entire codebase repeatedly, forget previous debugging breakthroughs, and ignore project-specific architectural conventions unless manually re-prompted.

Traditional RAG tools (Pinecone, Qdrant, naive vector search) failed to solve this because they treated agent memory like a flat text index. They lacked temporal awareness, steering capabilities, multi-agent consensus, and local offline capabilities. krusch-context-mcp was built to be the sovereign, zero-trust, multi-engine working memory server for the agent era.

2. How Local & Remote Agents Use the MCP Server

krusch-context-mcp exposes 42 standardized Model Context Protocol (MCP) tools over stdio JSON-RPC transport. Any client — whether a cloud-hosted IDE like Cursor, a CLI agent like Claude Code, or a 100% offline local agent running via Ollama — connects seamlessly to the exact same memory server.

• Local Agent Support: Local agents get instant sub-5ms zero-latency reads from the project-scoped SQLite cache (.agent/memory.db). No internet connection required.

• Cloud & Multi-Device Sync: When connected online, write-behind sync automatically pushes local memories to durable Polygres.com PostgreSQL.

• Multi-Agent Consensus: Multiple agents working on the same codebase share state in real-time. If Agent A fixes a bug, Agent B immediately inherits that lesson without re-auditing the code.

3. Deep Dive into the 5 Core Subsystems

[INSERT IMAGE: /home/krusch/Pictures/krusch_context_mcp_5_subsystems_diagram.png]

Subsystem 1: Episodic Memory & Temporal Recency Decay
Episodic memory records session learnings, past bugs, priorities, outcomes, and activity logs. Unlike flat vector search where a 6-month-old memory can distort current context, krusch-context-mcp applies mathematical exponential decay:

FinalScore = Similarity × e^(-0.01 × age_in_days)

A memory's relevance naturally decays ~26% after 30 days of inactivity. Recent architectural decisions automatically supersede stale historical workarounds without requiring manual deletion.

Subsystem 2: Holographic Steering Nuggets
Prompt bloat degrades model reasoning. Rather than stuffing 2,000-line system prompts into every turn, Holographic Nuggets maintain lightweight key-value steering facts. During planning turns, the agent queries nudges dynamically, retrieving micro-conventions exactly when needed.

Subsystem 3: Company Brain v2 (Multi-Agent Consensus & Provenance)
Designed for team collaboration and multi-agent coordination: parent-child version graphs, consensus conflict resolution (krusch_context_resolve_conflict), and role-based access lenses (krusch_context_search_lens).

Subsystem 4: Codebase & External Docs Search
Direct integration with pg-git indexes all source code blobs, git trees, commits, and external documentation manuals (such as polygres-docs and openrouter-docs) searchable via krusch_docs_search.

Subsystem 5: Proactive Trajectory Auditor & AI Watch Research Engines
Integrates 4 cutting-edge AI research subsystems: AgentDebugX (failure pattern matching), DataFlow-Harness (DAG operators), Rubric4Setwise (LLM reranking), and AREX (constraint auditing).

4. Feature Comparison

• Protocol Support: Native 42-Tool MCP Surface vs proprietary REST or basic memory.
• Temporal Recency Decay: Mathematical Exponential Decay (e^-0.01t) vs static similarity.
• Micro-Steering: Holographic Steering Facts vs static system prompts.
• Multi-Agent Consensus: Company Brain v2 Substrate vs isolated sessions.
• Offline Cache + Sync: Lakebase SQLite + Polygres.com Sync vs Cloud-only or local-only.

5. Deployment & Configuration

krusch-context-mcp supports 100% local, 100% cloud, or hybrid deployment.

# --- Polygres.com Cloud Database & Runtime API ---
POLYGRES_PROJECT_ID="p4b2ef196c33edbd8be43174"
POLYGRES_RUNTIME_URL="https://p4b2ef196c33edbd8be43174.api.db.polygres.com/v1"
POLYGRES_API_KEY="poly_live_YOUR_POLYGRES_API_KEY"

DATABASE_URL="postgresql://username:password@app.polygres.com:5432/kruschdb?sslmode=require"

# --- OpenRouter Cloud Embeddings (baai/bge-large-en-v1.5) ---
EMBEDDING_URL="https://openrouter.ai/api/v1/embeddings"
EMBEDDING_API_KEY="sk-or-v1-YOUR_OPENROUTER_API_KEY"
EMBED_MODEL="baai/bge-large-en-v1.5"

Links & Resources

• GitHub Repository: https://github.com/kruschdev/krusch-context-mcp
• Tool Reference: https://github.com/kruschdev/krusch-context-mcp/blob/main/docs/TOOL_REFERENCE.md
• Polygres Platform: https://polygres.com
• OpenRouter Embeddings: https://openrouter.ai
