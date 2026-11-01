# Krusch Context MCP

> Local MCP server: five tools to store, retrieve, and retire project decisions. SQLite by default — powering the `$0.00` Zero-LLM Raw-RAG + 4-Way RRF memory substrate behind **`#1 Overall` on Official `DolphinBench` (`89.17%`, `535/600` @ `$24.57`)** and `10M`-token ICLR 2026 `BEAM`.

[![Node.js 22+](https://img.shields.io/badge/Node.js-22+-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![MCP: 5 Verbs](https://img.shields.io/badge/MCP-5%20Core%20Verbs-blue.svg)](docs/TOOL_REFERENCE.md)
[![Storage: SQLite-First](https://img.shields.io/badge/Storage-SQLite--First%20(zero--Docker)-lightgrey.svg)](docs/ARCHITECTURE.md)
[![DolphinBench #1 Overall](https://img.shields.io/badge/DolphinBench-%231%20Overall%2089.17%25%20(%2424.57)-00e5ff.svg)](https://krusch.dev/articles/return-on-memory-dolphinbench.html)
[![Paper #27 PDF](https://img.shields.io/badge/Paper%20%2327-Return%20on%20Memory%20(PDF)-blueviolet.svg)](https://krusch.dev/papers/return-on-memory-dolphinbench.pdf)
[![Article: What Makes It Special](https://img.shields.io/badge/Article-What%20Makes%20It%20Special-cyan.svg)](https://krusch.dev/articles/what-makes-krusch-context-mcp-special.html)
[![Docs: What Makes It Special](https://img.shields.io/badge/Docs-What%20Makes%20It%20Special-purple.svg)](docs/WHAT_MAKES_IT_SPECIAL.md)
[![HOL Guard Catalog](https://img.shields.io/badge/HOL_Guard-Catalog_Listed-0B0F17?logo=shield&logoColor=00F5D4)](https://hol.org/guard/extension-studio?extension=mcp.krusch-context-mcp)
[![M8ven Score](https://m8ven.ai/badge/mcp/kruschdev/krusch-context-mcp)](https://m8ven.ai/mcp/kruschdev/krusch-context-mcp?s=readme)

> 📖 **Read the Systems & Benchmark Deep Dives**: Read [**Paper #27 — Return on Memory (`#1` Official DolphinBench `89.17%`)**](https://krusch.dev/articles/return-on-memory-dolphinbench.html) ([**PDF**](https://krusch.dev/papers/return-on-memory-dolphinbench.pdf)), [**Paper #26 — What DolphinBench Taught Us About Local AI**](https://krusch.dev/articles/what-dolphinbench-taught-us-about-local-ai.html), and [**Beyond Flat Vector RAG: What Makes krusch-context-mcp Special**](https://krusch.dev/articles/what-makes-krusch-context-mcp-special.html) ([`docs/WHAT_MAKES_IT_SPECIAL.md`](docs/WHAT_MAKES_IT_SPECIAL.md)).

**Krusch Context MCP** gives AI coding agents (Cursor, Claude Code, Windsurf, Antigravity) persistent working memory across sessions. It captures architectural decisions, invariants, lessons, and bug diagnoses, warns on near-duplicate memories, maintains temporal lineage when facts are superseded or invalidated, and audits diffs against active constraints.

---

## 🚫 What This Is Not

* **Not a codebase AST or Git indexer**: Code symbol search, call graphs, and Git DAG traversal belong in [`krusch-git`](https://github.com/kruschdev/krusch-git) or your IDE's native search.
* **Not a 61-tool cafeteria**: Collapsed to strictly 5 canonical verbs (~350 prompt tokens) for boring reliability.
* **Not a cloud SaaS platform**: Runs 100% locally on your machine with zero external cloud dependencies.
* **Not a monolithic domain suite**: Legal compliance ([`krusch-law`](https://github.com/kruschdev/krusch-law)), document ingestion ([`krusch-nexus`](https://github.com/kruschdev/krusch-nexus)), and contract graphs ([`krusch-biz`](https://github.com/kruschdev/krusch-biz)) live in separate companion repositories.

---

## ⚡ 30-Second Quickstart

Requires **Node.js >= 22.0.0**. Run once inside your project repository:

```bash
npx krusch-context-mcp init
```

This command will:
1. Validate Node >= 22.0.0 and initialize `.agent/context.db` via `node:sqlite`.
2. Clear stale MCP tool schemas from local IDE caches.
3. Create your project `.env` with sensible defaults.
4. Seed initial project context and run a diagnostic health check.
5. Print copy-paste JSON configurations for Cursor, Claude Code, and Claude Desktop.

---

## 🛠️ The 5-Verb Agent Loop

Krusch Context MCP exposes strictly **5 canonical verbs** designed to fit into standard coding workflows:

| Verb | Short Alias | Purpose |
| :--- | :--- | :--- |
| **`krusch_context_retrieve`** | `retrieve` | Pulls active memories, steering rules, and project state briefings within a strict `limit_tokens` budget. Returns citations. |
| **`krusch_context_remember`** | `remember` | Writes episodic facts and steering nuggets. Detects near-duplicates (`similarity >= 0.85`) and proposes `revise(action: 'supersede')` without blocking contrasting rules. |
| **`krusch_context_revise`** | `revise` | Updates stale knowledge (`supersede` with lineage tracking) or revokes obsolete rules (`invalidate` with mandatory reason). |
| **`krusch_context_nudge`** | `nudge` | Pre-commit auditor that checks proposed diffs against active project invariants (max 1–3 findings). Trigger defaults to `pre_commit` or `manual`; rejects `every_turn`. |
| **`krusch_context_health`** | `health` | Reports storage mode, memory counts by closed taxonomy, and 30-day TTL decay review. |

---

## 🤖 Recommended Agent Protocol

Coding agents should interact with memory at specific lifecycle boundaries:

```
┌─────────────────────────────────────────────────────────────┐
│ 1. SESSION START                                            │
│    Agent calls retrieve(query: '*', include_state: true)    │
│    -> Obtains active invariants, recent decisions, blockers │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│ 2. DURING WORK                                              │
│    Agent calls remember(content: '...', category: '...')    │
│    -> If near-duplicate returned, agent calls revise(...)   │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│ 3. PRE-COMMIT / PRE-EDIT                                    │
│    Agent calls nudge(trigger: 'pre_commit')                 │
│    -> Audits code against active invariants (max 3 findings)│
└─────────────────────────────────────────────────────────────┘
```

---

## 🛡️ Safe Memory Writes: Closed Taxonomy & Deduplication

To prevent memory hallucination and database pollution:

1. **Closed Taxonomy**: Every write must use one of 5 categories:
   * `decision`: Architectural choices, design directions, trade-offs.
   * `invariant`: Non-negotiable rules (e.g., "Use node:sqlite, zero native compiles").
   * `bug`: Solved defects, regressions, and root-cause analyses.
   * `lesson`: Tactical insights and framework discoveries.
   * `blocker`: Active dependencies or external obstacles.
2. **Near-Duplicate Detection**: If a proposed memory matches an existing active record ($\ge 0.85$ cosine similarity), the memory is saved with a warning proposing `revise(action: 'supersede', target_id: ...)`. This protects contrasting rules (e.g., "Allow CORS" vs "Do not allow CORS") while flagging twin facts.
3. **Compulsory Invalidation Reasons**: Calling `revise(action: 'invalidate')` strictly requires a non-empty `reason`.
4. **Focused Audits**: `nudge` caps findings at 3 with concrete evidence, rejecting `every_turn` triggers to eliminate auditor nagware.
5. **Span-Grounded Provenance & Drift Self-Healing**: Passing `provenance: { file, locator, quoted_sentence }` to `remember` computes a normalized SHA-256 `anchor_hash` and line range (`start_line..end_line`). On subsequent `retrieve(include_state: true)` calls, the engine verifies the span on disk—automatically healing line numbers when code shifts above it, or flagging `[DRIFTED]` when the underlying code changes.

---

## 🧠 Embedding Reality & Offline Mode

* **Zero-GPU Default**: If neither Ollama nor an API key is present, the engine runs 100% offline using deterministic keyword extraction, recency scoring, and heuristic tag indexing.
* **Local Ollama** (Optional): Set `OLLAMA_URL="http://127.0.0.1:11434"` with `EMBED_MODEL="snowflake-arctic-embed2"` (`8,192`-token context, `1024` dims, ~`664 MB` VRAM, asymmetric `query:` retrieval via `/api/embed`; also supports `qwen3-embedding` MRL `1024d`, `nomic-embed-text`, and legacy `bge-large`).
* **Remote Cloud** (Optional): Set `OPENROUTER_API_KEY="sk-..."` with `EMBED_MODEL="baai/bge-large-en-v1.5"` (or any `1024`-dim OpenRouter embedding model) for zero-local-VRAM embeddings.

---

## 🐘 When Do You Need PostgreSQL?

* **Use SQLite (Default)**: Perfect for single developers, local IDE sessions, and projects with thousands of decisions—featuring compact `Float32Array` binary vector blobs (`4 KB`/row) and an external-content Porter-stemmed `FTS5` lexical index. Zero Docker, zero setup.
* **Use PostgreSQL (`STORAGE_MODE=postgres`)**: Required only when scaling to multi-agent swarms across different machines needing centralized persistence and server-side pgvector HNSW indexing.

---

## 🔄 Migration from v1.6 / v1.7

* **Tool Aliases**: Legacy tool names (`add_memory`, `search_memory`, `compile_state`, `supersede_memory`, `invalidate_memory`, `proactive_nudge`) are automatically aliased to the 5 verbs with a deprecation notice.
* **Database Path**: v1.7 used `.agent/memory.db`. v1.8+ uses `.agent/context.db`. Run `npx krusch-context-mcp init` to migrate.
* See [docs/MIGRATION.md](docs/MIGRATION.md) for the complete mapping table.

---

## 🧩 Sibling Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                 AI Coding Agent (Cursor / Claude)           │
└──────────────────────────────┬──────────────────────────────┘
                               │
               ┌───────────────┴───────────────┐
               ▼                               ▼
┌─────────────────────────────┐ ┌─────────────────────────────┐
│  krusch-context-mcp (v2.0)  │ │   krusch-git (External)     │
│   Project Memory & Steering │ │   Codebase RAG & AST Search │
│       (5 Canonical Verbs)   │ │      (7 Specialized Tools)  │
└──────────────┬──────────────┘ └─────────────────────────────┘
               │
               ▼
┌─────────────────────────────┐
│     .agent/context.db       │
│   (node:sqlite, Node ≥22)   │
└─────────────────────────────┘
```

Other specialized tools ([`krusch-nexus`](https://github.com/kruschdev/krusch-nexus), [`krusch-law`](https://github.com/kruschdev/krusch-law), [`krusch-biz`](https://github.com/kruschdev/krusch-biz)) run as independent MCP servers in their own repositories.

---

## 💻 IDE Configuration

### Cursor (`.cursor/mcp.json`)
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

### Claude Code
```bash
claude mcp add krusch-context -- npx -y krusch-context-mcp
```

### Claude Desktop (`claude_desktop_config.json`)
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

---

## 🏆 Verified External Benchmarks

### `#1 Overall` on Official DolphinBench (`89.17%`, `535/600` @ `$24.57`) — *Return on Memory*

Evaluating all **`600/600` multi-app workspace tasks** across **`13,539` conversational sessions (`1.5M` `o200k_base` tokens)** under the official `openai/gpt-5.6-sol` judge (`7` clean-room runs = `4,200` traces), our **byte-identical `0o444` read-only frozen Zero-LLM Raw-RAG (`256/32`-token windows) + Porter-FTS5 BM25 + `snowflake-arctic-embed2` (`1024d`) 4-Way RRF `node:sqlite` store (`$0.00` ingestion)** achieves **`#1 Overall` (`89.17%`)** when paired with `Gemini 4 Argon` and a **`$0.00` zero-cloud floor (`42.67%`)** on local open weights:

| Agent Reader + Memory Substrate | Overall (`600`) | Persona Breakdown (`Morgan` / `Alex` / `Riley`) | Checks / Key Delta | Total Cost |
| :--- | :--- | :--- | :--- | :--- |
| **`Sovereign Raw-RAG + Gemini 4 Argon`** (`medium`) | **`89.17%` (`535/600`, `#1 Overall`)** | **`92.0%` (`184`) / `87.0%` (`174`) / `88.5%` (`177`)** | **`+18.50 pp` (`+111` tasks)** > `#1` `Mem0` · Mech `89.8%` (`1,193/1,329`) · Sem `92.2%` (`545/591`) | **`$24.57`** (`$0.00` ingest, `56.5%` cache hit, `~4x` cheaper) |
| *Official `#1` Cloud: `Hermes + GPT 5.6 Luna + Mem0`* | *`70.67%` (`424/600`)* | *— / `66.0%` / `68.0%`* | *Official `dolphinbench.ai` Cloud Leader (`14x` cheaper vs. `Supermemory` `59.17%` @ `$345.64`)* | *`$96.21`* |
| **`Qwen3-Coder-30B-A3B` Wave-4 QLoRA+DPO** (`3.3B` active) | **`42.67%` (`256/600`)** | `55.5%` (`111`) / `35.0%` (`70`) / `37.5%` (`75`) | **`85.73%` Mech** (`42.00%` Stock) · Beats `MiniMax M3 + Hindsight` (`41.00%` @ `$158.33`) & `Sonnet 5 + Honcho/Mem0` (`35.83%`/`32.33%` @ `$1.57K`/`$1.83K`) | **`$0.00`** |
| **`gpt-oss:120b` Wave-4 QLoRA+DPO** (`5.1B` active) | **`39.50%` (`237/600`)** | `54.5%` (`109`) / `31.5%` (`63`) / `32.5%` (`65`) | `+7.33 pp` Raw-RAG + 4-Way RRF lift over raw turns (`39.17%` Stock) | **`$0.00`** |
| **`Qwen3-Coder-Next-80B` Stock** (`3.0B` active / `79.7B`) | **`38.50%` (`231/600`)** | `52.0%` (`104`) / `34.0%` (`68`) / `29.5%` (`59`) | Offline MoE scaling-law control | **`$0.00`** |
| **`Hermes-3-Llama-3.1-8B` Wave-4 LoRA+DPO** (`Q4_0`) | **`18.33%` (`110/600`)** | `26.0%` (`52`) / `14.5%` (`29`) / `14.5%` (`29`) | **`15.7x` lift** over `1.17%` stock (`Ollama .System` fix + BF16 LoRA+DPO) | **`$0.00`** |

* **Three *Return on Memory* Scaling Laws**: (1) **`92.33%` (`554/600`) `Oracle@7` retrieval sufficiency** across the frozen `0o444` SQLite store (`69.33%` `Oracle@6` open-weights; `138/600` uniquely solved by Argon); (2) **`3.88x` superlinear reader multiplier at `LBF=4+`** (`1.81x` → `2.04x` → `2.69x` → `3.88x`; `82.7%` vs. `21.3%` `30B`); and (3) **`4.4x` flatter corpus-entropy slope** (`-3.50 pp` `Morgan` → `Riley` vs. `-15.50 pp` on lossy LLM-summarized `Mem0`).
* **Verified Upstream Queue & Open Artifacts**: All **`6/6` sovereign submission `.zip` archives** (`export_submission --check`, `error_code: null`; Argon Submission UUID `29389157-b01b-42b5-8193-17d9a496f580`, SHA-256 `9a7fa41fb3d1cf5f71f0c3cf74a0c97f8f39d50e26a7dd484c323f7719ecb7a0`) hold `status: "queued"` on `dolphinbench.ai` awaiting maintainer merge (`dolphinbench.ai/leaderboard/results.json` currently lists the `13` commercial cloud baselines). Read [**Paper #27 (HTML)**](https://krusch.dev/articles/return-on-memory-dolphinbench.html) · [**Paper #27 (PDF)**](https://krusch.dev/papers/return-on-memory-dolphinbench.pdf) · [**Paper #26 (Local AI Ablation)**](https://krusch.dev/articles/what-dolphinbench-taught-us-about-local-ai.html) · [**`29` SHA-256 Raw Audit Logs (`krush420/sovereign-g4-benchmarks`)**](https://huggingface.co/datasets/krush420/sovereign-g4-benchmarks).

### Official ICLR 2026 BEAM (`100K`–`10M` Tokens, `2,000/2,000` Probes)

* Closed-system full-suite evaluation across all **`100` conversations (`~178.34M` tokens) and `2,000/2,000` questions** (`100K`, `500K`, `1M`, `10M` splits) on `node:sqlite` + `snowflake-arctic-embed2` (`8K` ctx) in a fixed `~8K` prompt budget: reaches **`92.58%` (`100K`) & `93.00%` (`10M` IE) recall** (`78.67%` 4-split weighted), exhibits **zero E2E QA degradation from `100K` → `1M`** (`70.60%` → `71.82%` → `72.86%` on `hermes3`), and **outperforms cloud `past.dev` (`openai/gpt-5.6-luna`)** on **Contradiction Resolution across all `4/4` splits** and on **`10M` Multi-Session Reasoning across both cross-family referees** (`29.54%` / `38.33%` vs. `28.17%`) with `10/10` zero-leakage verification ([full report](benchmarks/BEAM_EMPIRICAL_REPORT.md)).

---

## 📚 Documentation & Specifications

* **[Canonical Tool Reference](docs/TOOL_REFERENCE.md)**: Generated directly from live schemas (`npm run docs:generate`).
* **[Architecture & Failure Modes](docs/ARCHITECTURE.md)**: 2-page specification covering schemas, indexes, and `v2.0.0` multi-scale retrieval invariants.
* **[Setup & Operations Guide](docs/SETUP.md)**: Zero-Docker setup and optional configurations.
* **[Migration Guide](docs/MIGRATION.md)**: Step-by-step v1.5 → v1.6 → v1.7 → v1.8 → v1.9.0 → v2.0.0 mapping.
* **[Episodic Memory Guide](docs/EPISODIC_MEMORY.md)**: Deep dive into the closed taxonomy and lifecycle.
* **[Changelog](CHANGELOG.md)**: Version release notes.
* **[Official ICLR 2026 BEAM Empirical Report](benchmarks/BEAM_EMPIRICAL_REPORT.md)**: Full `100`-conversation (`~178.34M`-token), `2,000/2,000`-probe methodology, per-ability tables, and `10/10` zero-leakage verification gates.
* **[Official DolphinBench Whitepapers & Clean-Room Audit Logs](https://krusch.dev/articles/return-on-memory-dolphinbench.html)**: [**Paper #27 (HTML)**](https://krusch.dev/articles/return-on-memory-dolphinbench.html), [**Paper #27 (PDF)**](https://krusch.dev/papers/return-on-memory-dolphinbench.pdf), [**Paper #26**](https://krusch.dev/articles/what-dolphinbench-taught-us-about-local-ai.html), and all `7` `dolphinbench_600` runs (`4,200` official `gpt-5.6-sol` traces, `6/6` `status: "queued"` archives led by `89.17%` Argon UUID `29389157-b01b-42b5-8193-17d9a496f580` + `42.67%` `$0.00` `30B` Wave-4) in [`krush420/sovereign-g4-benchmarks`](https://huggingface.co/datasets/krush420/sovereign-g4-benchmarks).
* **[Evaluation Baseline Notes](evals/README.md)**: Preliminary benchmark fixtures and token-budget metrics.

---

## 🧪 Testing

```bash
# Run full unit & contract test suite (100% SQLite, zero Docker)
npm test

# Check storage and memory health
npm run health
```

---

## License

MIT © [kruschdev](https://github.com/kruschdev)
