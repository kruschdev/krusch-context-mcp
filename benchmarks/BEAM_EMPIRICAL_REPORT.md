# Official ICLR 2026 BEAM Benchmark — Closed-System Full-Split Empirical Report (`krusch-context-mcp v1.9.0`)

> **Audit & Execution Date**: 2026-10-25  
> **Dataset**: Official `Mohammadta/BEAM` (`100K` Split — 20 Multi-Session Conversations, 5,732 Messages / 2,866 Turns, 12,232,071 Characters / ~3.06M Tokens, **All `400/400` Probing Questions** across 10 Memory Categories)  
> **Execution Topology**: Hermetic Single-Box Closed System on **NVIDIA RTX PRO 6000 Blackwell (`97,887 MiB` VRAM, Driver `580.82.07`)** — `127.0.0.1:11434` loopback only, `GEMINI_API_KEY=""`, zero LAN calls, fresh Hugging Face dataset fetch, fresh cold-room `snowflake-arctic-embed2:latest` (`8,192` ctx, `1024d`, asymmetric `query:` retrieval) embeddings from scratch (`40.62s`), and 4 open-weights models co-located simultaneously at `100% GPU`  
> **Verification Command**: `npm run bench:beam:verify` ([`benchmarks/verify_zero_leakage.js`](./verify_zero_leakage.js))  
> **Raw Audit Logs**:
> - Primary Unmodified Stock `gpt-oss:120b` (`n = 400/400`, `v1.9.0`, `snowflake-arctic-embed2:latest`): [`benchmarks/beam_100k_audit_log.json`](./beam_100k_audit_log.json) (mirrored at [`benchmarks/g4_closed_system/beam_100k_audit_log.json`](./g4_closed_system/beam_100k_audit_log.json))
> - Controlled `krush420/gpt-oss-120b-sre-lora` Full Split (`n = 400/400`, `v1.9.0`, `snowflake-arctic-embed2:latest`): [`benchmarks/g4_closed_system/beam_100k_qlora_full400_audit_log.json`](./g4_closed_system/beam_100k_qlora_full400_audit_log.json)
> - Historical `v1.8.1` QLoRA Gate Slice (`n = 20/400`): [`benchmarks/g4_closed_system/beam_100k_qlora_n20_audit_log.json`](./g4_closed_system/beam_100k_qlora_n20_audit_log.json)

---

## 1. Executive Summary

Following three rounds of adversarial anti-gaming audits (`19/19` findings fixed across Rounds 1–2 plus full-split `n = 400/400` closed-system enforcement in Round 3) and the `v1.9.0` production embedding cutover from `512`-token `bge-large` to `8,192`-token **`snowflake-arctic-embed2:latest`**, we executed a **complete hermetic, single-box, 100% open-weights `n = 400/400` full-split evaluation** (both unmodified Stock `gpt-oss:120b` and controlled in-place `krush420/gpt-oss-120b-sre-lora` QLoRA) on an isolated **NVIDIA RTX PRO 6000 Blackwell (`96 GB`)** instance via [`scripts/run_beam_closed_g4.sh`](../scripts/run_beam_closed_g4.sh).

### Headline Empirical Findings (`v1.9.0` + `snowflake-arctic-embed2:latest`, `n = 400/400` Official `100K` Split)

1. **Retrieval Recall (`Table A`, `n = 360/360` Ground-Truth Questions across 9 Categories, Fresh Cold-Room `snowflake-arctic-embed2` Embeddings in `40.62s`)**:
   - **Substantial Fixed-Rank Top-K Retrieval Gains over `512`-Token `bge-large`**:
     - **`Hybrid Recall@10`**: **`57.69%`** (**`+3.49 pp`** over `v1.9.0` `bge-large` `54.20%` and **`+5.26 pp`** over `v1.8.1` `52.43%`), highlighted by Instruction Following (`+9.17 pp` to `53.13%`), Temporal Reasoning (`+6.25 pp` to `95.00%`), Event Ordering (`+5.21 pp` to `22.63%`), Preference Following (`+4.70 pp` to `42.31%`), Knowledge Update (`+2.50 pp` to `87.50%`), and Contradiction Resolution (`+2.50 pp` to `81.67%`).
     - **`Hybrid Recall@20`**: **`70.88%`** (**`+2.77 pp`** over `bge-large` `68.11%`; Event Ordering `+6.19 pp`, Information Extraction `+5.00 pp`, Instruction Following `+4.17 pp`, Temporal Reasoning `+3.75 pp`).
     - **`Hybrid Recall@30`**: **`78.04%`** (**`+1.37 pp`** over `bge-large` `76.67%`; Temporal Reasoning reaches **`100.00%`** already at `R@30`).
     - **`Hybrid Recall@50`**: **`88.69%`** (vs. `88.87%` `bge-large`).
   - **`krusch-context-mcp v1.9.0` Hybrid `unifiedRetrieve` (`~67.9` condensed turns packed in `~7,931` est. tokens)**: **`92.37%`** primary-turn recall (**`100.00%`** on Temporal Reasoning and Contradiction Resolution; **`98.75%`** on Instruction Following; **`97.50%`** on Knowledge Update; **`95.30%`** on Preference Following; **`93.75%`** on Information Extraction; **`91.42%`** on Multi-Session Reasoning [`+0.83 pp` vs. `bge-large`]; **`79.88%`** on Event Ordering) while packing **8.1 fewer turns per query** (`67.9` vs. `76.0`) than pure dense retrieval to reserve token headroom for structured chronological timelines, passive state-evolution traces, and contradiction alerts.
   - **Fair Condensed `Dense snowflake-arctic-embed2 8K` Baseline (`~76.0` condensed turns, identical condensation + budget)**: **`92.41%`** (**`+0.93 pp`** over pure `bge-large` `91.48%` and **`23.1%` faster** cold-room embedding: `40.62s` vs. `52.85s` for `3,266` records), driven by zero `512`-token truncation on long dialogue turns (`Summarization` `+5.47 pp` from `75.91%` $\rightarrow$ **`81.38%`**; `Event Ordering` `+2.76 pp` from `72.28%` $\rightarrow$ **`75.04%`**; `Multi-Session Reasoning` `+1.05 pp` from `91.88%` $\rightarrow$ **`92.93%`**).
   - **Un-Condensed Lexical 8K Baseline (`~7.5` raw turns)**: **`30.74%`**.

2. **Isotropic Contrastive Calibration Discovery (`calibrateQuerySimilarity` in [`src/embedding-helper.js`](../src/embedding-helper.js))**:
   - Unlike anisotropic BERT embedders (`bge-large`, where unrelated pairs cluster at `0.48–0.55` cosine and paraphrases at `0.68–0.85`), asymmetric InfoNCE models (`snowflake-arctic-embed2`, `qwen3-embedding` with `query:` prefix) produce isotropic cosine distributions where unrelated pairs center near `0.00` (`-0.03` to `+0.08`) and zero-lexical-overlap paraphrases land at `0.35–0.55`.
   - Adding model-aware [`calibrateQuerySimilarity`](../src/embedding-helper.js) aligned `snowflake-arctic-embed2` onto `unifiedRetrieve`'s `[0, 1]` hybrid relevance and epistemic abstention gates without altering `bge-large` or sparse unit-test vectors (`80/80` tests passing), lifting `snowflake-arctic-embed2` `Recall@10` from `53.40%` $\rightarrow$ **`57.69%`** (`+4.29 pp`) and `Packed 8K` from `90.87%` $\rightarrow$ **`92.37%`**.

3. **Full-Benchmark End-to-End Conversational QA (`Table B`, All `n = 400/400` Questions, Zero Self-Grading Bias)**:
   - All `400` answers generated by **unmodified open-weights `gpt-oss:120b`** (`think: "low"`, `16,384` ctx, `2,578.1s` total wall time) inside the isolated G4 box were graded simultaneously by **two independent cross-family Referee Judges**:
     - **Primary 32B Dense Referee (`qwen2.5:32b`, Alibaba Qwen family)**: **`64.26%`** (`n = 400/400`; `74.43%` across the 8 categories excluding `EO` & `KU`)
     - **Continuity 8B Referee (`hermes3:latest`, Nous/Meta Llama-3.1 family)**: **`70.60%`** (`n = 400/400`; `76.92%` across the 8 categories excluding `EO` & `KU`)
     - **Cross-Family Inter-Rater Agreement (`n = 400`)**: **`88.00%` (`352/400`) binary pass/fail agreement**, **`80.50%` (`322/400`) within `±0.25`**, and **`71.00%` (`284/400`) exact rubric score match** (`84.00%` binary / `78.50%` within `±0.25` / `71.00%` exact on the `400/400` QLoRA run).
   - **Category Highs under `snowflake-arctic-embed2:latest` (vs. `v1.9.0` `bge-large` Baseline)**:
     - **Contradiction Resolution (`CR`, `40/40`)**: `79.69%` $\rightarrow$ **`85.94%` (`+6.25 pp`)** on `qwen2.5:32b` and `85.00%` $\rightarrow$ **`92.50%` (`+7.50 pp`)** on `hermes3:latest` — **surpassing proprietary cloud `past.dev` (`78.13%`) by `+7.81 pp` and `+14.37 pp` across all 40 questions**.
     - **Summarization (`SUM`, `40/40`)**: `78.19%` $\rightarrow$ **`90.46%` (`+12.27 pp`)** on `hermes3:latest` (`77.46%` on `qwen2.5:32b`).
     - **Temporal Reasoning (`TR`, `40/40`)**: `78.75%` $\rightarrow$ **`82.50%` (`+3.75 pp`)** on `qwen2.5:32b` and `80.00%` $\rightarrow$ **`82.50%` (`+2.50 pp`)** on `hermes3:latest`.
     - **Event Ordering (`EO`, `40/40`)**: `8.51%` $\rightarrow$ **`9.68%` (`+1.17 pp`)** on `qwen2.5:32b` and `36.25%` $\rightarrow$ **`43.17%` (`+6.92 pp`)** on `hermes3:latest`.
     - **Preference Following (`PF`, `40/40`)**: `91.25%` $\rightarrow$ **`91.88%` (`+0.63 pp`)** on `qwen2.5:32b` (`85.00%` on `hermes3:latest`).
   - **Retrieval-Precision vs. Reader-Distractor Tradeoff (`-2.93 pp` overall E2E vs. `bge-large` `67.19%` / `73.53%`)**: While `snowflake-arctic-embed2` improved top-rank retrieval (`R@10 +3.49 pp`, `R@20 +2.77 pp`, `Dense 8K +0.93 pp`) and lifted 5 categories, stronger semantic neighborhood recall surfaced more topically adjacent distractor turns on unanswerable `Abstention` probes whose entities appear elsewhere in the chat (`73.75%` $\rightarrow$ `61.25%` Qwen; `85.00%` $\rightarrow$ `67.50%` Hermes) and elevated pre-update historical turns into Tier-1 slots on blind un-superseded `Knowledge Update` (`47.50%` $\rightarrow$ `37.50%` Qwen) and `Information Extraction` (`77.08%` $\rightarrow$ `68.59%` Qwen) queries (analyzed in Section 7).

4. **Controlled `400/400` Stock `gpt-oss:120b` vs. `krush420/gpt-oss-120b-sre-lora` (QLoRA) Ablation (`Table C`)**:
   - Fusing our 144-pair (`288` matrix) `BF16` rank-16 attention adapter (`krush420/gpt-oss-120b-sre-lora`) into `gpt-oss:120b` in-place (`2.00s`) achieved **`60.80%`** (`qwen2.5:32b`) and **`69.03%`** (`hermes3:latest`) across all `400/400` questions (`3,313.8s` wall time).
   - Unmodified Stock `gpt-oss:120b` leads overall on mixed general-domain chat (`64.26%` vs. `60.80%` on `qwen2.5:32b`; `70.60%` vs. `69.03%` on `hermes3:latest`), while the SRE QLoRA **outperforms Stock on structured state-tracking categories**:
     - **Contradiction Resolution (`CR`, `n = 40`)**: **`85.00%`** (`qwen2.5:32b`) / **`98.13%`** (`hermes3:latest`, **`+5.63 pp`** over Stock `92.50%` and **`+20.00 pp`** above `past.dev` `78.13%`).
     - **Knowledge Update (`KU`, `n = 40`)**: **`38.75%`** vs. `37.50%` (`+1.25 pp` on `qwen2.5:32b`) and **`52.50%`** vs. `47.50%` (`+5.00 pp` on `hermes3:latest`).
     - **Information Extraction (`IE`, `n = 40`)**: **`69.53%`** vs. `68.59%` (`+0.94 pp` on `qwen2.5:32b`) and **`73.75%`** vs. `70.63%` (`+3.12 pp` on `hermes3:latest`).
     - **Multi-Session Reasoning (`MSR`, `n = 40`)**: **`62.87%`** vs. `54.87%` (`+8.00 pp` on `hermes3:latest`).
     - **Preference Following (`PF`, `n = 40`)**: **`89.38%`** vs. `85.00%` (`+4.38 pp` on `hermes3:latest`).

5. **Built-In Anti-Gaming Canary Trap (`Conv 14 KU Q1`)**: **`0.00` (`UN-GAMED`)** across every run (`verify_zero_leakage.js` Check 5).

---

## 2. Hermetic Closed-System Architecture & Cryptographic Provenance

To eliminate every external dependency questioned in peer review (multi-node LAN calls, pre-cached embeddings, cloud APIs, or model self-judging), [`scripts/run_beam_closed_g4.sh`](../scripts/run_beam_closed_g4.sh) provisioned a clean-room environment from scratch on a single **96 GB NVIDIA RTX PRO 6000 Blackwell** VM (`15.75` Colab Compute Units total for both `400/400` runs; verified `0` active sessions / `0.00/hr` burn post-teardown):

- **Network & API Isolation**: `OLLAMA_HOST=127.0.0.1:11434`, `GEMINI_API_KEY=""`, zero `.env` files, zero `.agent/context.db` state, and fresh HTTPS download of `Mohammadta/BEAM` (`100K` split) directly from Hugging Face (`datasets-server.huggingface.co`), parsed via zero-dependency [`parseJsonOrPythonLiteral`](../scripts/benchmark_official_beam.js).
- **Simultaneous 4-Model `100% GPU` Co-Location (`~91.2 GB / 97.9 GB` VRAM)**:
  - **Embedder**: `snowflake-arctic-embed2:latest` (`689 MB`, Snowflake Arctic Embed 2.0 1024-dim, `8,192` ctx — embedded all `3,266` raw dialogue turns + asymmetric `query:` probes from scratch in `40.62s`)
  - **Reader**: `gpt-oss:120b` (`64 GB`, OpenAI 117B MXFP4 MoE, `16,384` ctx, `think: "low"`, `num_predict: 2560`)
  - **Primary Judge (32B Dense)**: `qwen2.5:32b` (`21 GB`, Alibaba Qwen 2.5 32B, `4,096` ctx, `temperature: 0`)
  - **Continuity Judge (8B Dense)**: `hermes3:latest` (`5.5 GB`, Nous Hermes 3 Llama-3.1 8B, `4,096` ctx, `temperature: 0`)

### Cryptographic Provenance (`SHA-256`)

| Artifact / Open-Weights Model | Path / Tag | Verified SHA-256 Digest |
| :---------------------------- | :--------- | :---------------------- |
| **Official BEAM 100K Dataset** | `/tmp/beam_100k_official.json` | `d542da9ed3b8525cca2f7c4452d54d8c71aa9e8e49d35532b2658da630e6eb43` |
| **Embedding & Isotropic Calibration (`v1.9.0`)** | [`src/embedding-helper.js`](../src/embedding-helper.js) | `7d60fc55d0b2fdb86f9bbd6832688682b131f2b44107f7c0db65d3e79dec6129` |
| **Unified Retrieval Orchestrator (`v1.9.0`)** | [`src/unified-retrieval.js`](../src/unified-retrieval.js) | `b2f49453b27470ca53abbdd7e04f7861a6c96280998b39a84a7eee1eb58eb6ea` |
| **Lexical & Stemming Module (`v1.9.0`)** | [`src/retrieval-lexical.js`](../src/retrieval-lexical.js) | `1830010d07e1ac97111a1016fe52cbe5759c93faf6f559fe83cf9672507d7ddf` |
| **Epistemic & Conflict Module (`v1.9.0`)** | [`src/retrieval-epistemic.js`](../src/retrieval-epistemic.js) | `19e87ecb8f704a2d41f97d70f187402db4df5ab77438bd3f70044dd96dfcbc07` |
| **Stage-Aware Prune Helper** | [`src/prune-helper.js`](../src/prune-helper.js) | `7d62689937de065cc0da3a779fb50b1599dd46cb9a5cf749a376e87c4bbafb12` |
| **Un-Gamified Benchmark Harness** | [`scripts/benchmark_official_beam.js`](../scripts/benchmark_official_beam.js) | `1c6d70c307b0dfa29ca5548d8e731a5ef11bc0e0104c6de030f271aeca16c57e` |
| **Primary Stock `400/400` Audit Log (`v1.9.0`, `snowflake-arctic-embed2`)** | [`benchmarks/beam_100k_audit_log.json`](./beam_100k_audit_log.json) | `b01330af93d00f1d0d498cf47421dcc3b6ec116e88e43423bfa5103e7d840eb0` |
| **Controlled QLoRA `400/400` Audit Log (`v1.9.0`, `snowflake-arctic-embed2`)** | [`benchmarks/g4_closed_system/beam_100k_qlora_full400_audit_log.json`](./g4_closed_system/beam_100k_qlora_full400_audit_log.json) | `69f93d66504baa53ec6ccde88f9b0019a473f718bacb393508dddae5aeedbdd6` |
| **Reader Model (`gpt-oss:120b`)** | `ollama://gpt-oss:120b` | `714d86958b6e870a9320e78126ac1ce3477727a1cd9bf7194b8ace0d84c62fd8` |
| **Primary Judge (`qwen2.5:32b`)** | `ollama://qwen2.5:32b` | `9f13ba1299afea09d9a956fc6a85becc99115a6d596fae201a5487a03bdc4368` |
| **Continuity Judge (`hermes3:latest`)** | `ollama://hermes3:latest` | `4f6b83f30b62bc3d0cf9be09266db222805ee815c8fd7d8b38f863f655be78b7` |
| **Embedding Model (`snowflake-arctic-embed2:latest`)** | `ollama://snowflake-arctic-embed2:latest` | `5de93a84837d0ff00da872e90830df5d973f616cbf1e5c198731ab19dd7b776b` |
| **Prior Baseline Embedder (`bge-large:latest`)** | `ollama://bge-large:latest` | `b3d71c92805938e2c9d78e6f35e82d7cc1bd77e05b47dd2ab3016240f4021c15` |

---

## 3. Three-Round Adversarial Honesty & Anti-Gaming Audit Summary

| # | Audit ID | Flaw / Limitation Identified | Remediation Applied & Enforced by `verify_zero_leakage.js` |
| :- | :------- | :--------------------------- | :--------------------------------------------------------- |
| **1** | **Tier-3 Stub Stuffing (R1)** | Compressing turns 23+ to 92-char user-only stubs (`~25` tok) packed all 140–196 turns into 8K tokens (`Recall@All = 100%`). | Removed `maxBodyChars = 92` and user-only slicing. Every packed turn preserves `USER:` + `\| ASSISTANT:` (`680 / 440 / 320` chars; `67.9` turns/query `<= 70.0`). Enforced by Check 5. |
| **2** | **Judge False Positives (`BUG-06`, R2)** | Putting `"scores": [1.0]` before `"reason"` caused 8B `hermes3` to award `1.0` to wrong Reader answers (`March 31` vs `March 29`, `3 columns` vs `2`). | Switched Judge to `format: "json"` with `"reason"` **before** `"scores"`, removed concrete `1.0` schema anchors, and grounded grading against reference answers + rubrics. |
| **3** | **Handicapped Legacy Baseline (`ARCH-04`, R2)** | `legacyRetrieveSimulation` packed `~7.5` un-condensed raw turns, making `"Fair Legacy 8K"` an unfair comparison against condensed turns. | Fixed punctuation tokenization in `Un-Condensed Lex 8K` (`30.74%`) and added **`Dense 8K` (`92.41%` `snowflake-arctic-embed2` / `91.48%` `bge-large`)** using identical `680 / 440 / 320` condensation. |
| **4** | **Ingestion Regex Preprocessing (`ARCH-05`, R2)** | `buildBlindTurnsFromChat` ran `isInstruction` / `isPreference` regexes during ingestion to set `category = 'invariant'` and dual-write `ide_agent_nuggets`. | Deleted `isInstruction`, `isPreference`, and `insertNugget` from [`scripts/benchmark_official_beam.js`](../scripts/benchmark_official_beam.js) (banned in Check 2). Every turn is ingested uniformly as `category = 'decision'`. |
| **5** | **Metric Conflation & Token Ratio (`ARCH-06`, R2)** | Placing 9-category Retrieval Recall next to 10-category End-to-End QA conflated retrieval with QA, and BPE ratios were undisclosed. | Separated **Table A (Retrieval Recall)** from **Table B (End-to-End QA)** and disclosed `31,725` chars = `~7,931` est. tokens (`@4.0`) $\approx$ `~8,937` BPE tokens (`@3.55`). |
| **6** | **Sample-Size & Single-Judge Variance (R3 External Critique)** | Preliminary Table B only evaluated `n = 20/400` (`5%` sample) with a single 8B Judge and relied on multi-host / cloud API endpoints; cold-room Hugging Face downloads failed on Python `repr()` strings. | Executed full **`n = 400/400`** closed-system runs on a single isolated G4 box (`127.0.0.1:11434`), added **Dual Cross-Family Judges (`qwen2.5:32b` + `hermes3:latest`)** verified in Check 4, and added zero-dependency [`parseJsonOrPythonLiteral`](../scripts/benchmark_official_beam.js) for standalone cold-room fetches. |

---

## 4. Official ICLR 2026 BEAM Empirical Results (`snowflake-arctic-embed2:latest` `8,192` Ctx, All `400/400` Questions / 20 Conversations / 3.06M Tokens)

### Table A: 9-Category Ground-Truth Primary Turn Retrieval Recall (`n = 360` Questions with `source_chat_ids`)

> *Measures pure retrieval accuracy of `krusch-context-mcp v1.9.0` (`unifiedRetrieve`) against upstream `source_chat_ids` using fresh cold-room `snowflake-arctic-embed2:latest` (`8,192` ctx, `1024d`, asymmetric `query:` prefix) embeddings (Abstention has no ground-truth turn IDs by definition). Both `Dense snowflake-arctic-embed2 8K` (`~76.0` turns) and `Hybrid Packed 8K` (`~67.9` turns + timeline/state-evolution/epistemic headers) use identical `680 / 440 / 320` char `prunePreSynthesis` condensation within an `8,000`-estimated-token (`@ 4.0 chars/tok`, `31,725` chars $\approx$ `~8,937` BPE tokens) budget.*

| BEAM Memory Category (40 Qs each) | Un-Condensed Lex 8K (`~7.5t`) | Condensed Dense `arctic-embed2` 8K (`~76.0t`) | Hybrid `Recall@10` | Hybrid `Recall@20` | Hybrid `Recall@30` | Hybrid `Recall@50` | **Hybrid Packed 8K (`~67.9t`)** |
| :-------------------------------- | :---------------------------: | :-------------------------------------------: | :----------------: | :----------------: | :----------------: | :----------------: | :-----------------------------: |
| **Information Extraction (IE)** | `28.33%` | `95.00%` | `60.42%` | `72.92%` | `75.42%` | `91.25%` | **`93.75%`** |
| **Knowledge Update (KU)** *(incl. Conv 14 Q1 Canary = 0)* | `58.54%` | `95.83%` | `87.50%` | `89.79%` | `92.92%` | `95.00%` | **`97.50%`** |
| **Temporal Reasoning (TR)** | `53.75%` | `100.00%` | `95.00%` | `96.25%` | `100.00%` | `100.00%` | **`100.00%`** |
| **Event Ordering (EO)** | `6.93%` | `75.04%` | `22.63%` | `37.00%` | `49.87%` | `70.10%` | **`79.88%`** |
| **Contradiction Resolution (CR)** | `50.37%` | `95.75%` | `81.67%` | `88.00%` | `94.12%` | `98.75%` | **`100.00%`** |
| **Multi-Session Reasoning (MSR)** | `26.48%` | `92.93%` | `55.85%` | `60.33%` | `69.38%` | `87.02%` | **`91.42%`** |
| **Instruction Following (IF)** | `11.25%` | `97.50%` | `53.13%` | `81.46%` | `86.67%` | `96.67%` | **`98.75%`** |
| **Preference Following (PF)** | `32.48%` | `98.29%` | `42.31%` | `78.21%` | `89.32%` | `95.30%` | **`95.30%`** |
| **Summarization (SUM)** | `8.56%` | `81.38%` | `20.67%` | `33.99%` | `44.66%` | `64.12%` | **`74.70%`** |
| **9-CATEGORY RETRIEVAL RECALL MEAN** | **`30.74%`** | **`92.41%`** | **`57.69%`** | **`70.88%`** | **`78.04%`** | **`88.69%`** | **`92.37%`** |

---

### Table B: Full `400/400` 10-Category End-to-End Conversational QA — Closed-System Open-Weights `gpt-oss:120b` (`v1.9.0` + `snowflake-arctic-embed2`) vs. Published `100K` Leaderboard

> *Measures full-benchmark (`n = 400/400`) downstream answer generation inside the isolated G4 box (`2,578.1s` total wall time). Every answer from unmodified open-weights `gpt-oss:120b` is graded independently by **both** `qwen2.5:32b` (32B dense primary referee) and `hermes3:latest` (8B continuity referee) against official `ideal_response` + `rubric` ground truth. Note: `past.dev` (`92.08%`) explicitly discloses single-model proprietary self-judging (`openai/gpt-5.6-luna` both answers and judges).*

| BEAM Memory Category | Eval Qs | **Stock `gpt-oss:120b` (`qwen2.5:32b` 32B Judge)** | **Stock `gpt-oss:120b` (`hermes3:latest` 8B Judge)** | `past.dev` (`100K`, `n=400`) | `past.dev` (`1M`) |
| :------------------- | :-----: | :------------------------------------------------: | :--------------------------------------------------: | :--------------------------: | :---------------: |
| **Information Extraction (IE)** | `40/40` | `68.59%` | `70.63%` | `95.00%` | `83.98%` |
| **Knowledge Update (KU)** | `40/40` | `37.50%` | `47.50%` | `89.38%` | `85.71%` |
| **Temporal Reasoning (TR)** | `40/40` | `82.50%` | `82.50%` | `95.00%` | `96.79%` |
| **Event Ordering (EO)** | `40/40` | `9.68%` | `43.17%` | `100.00%` | `99.81%` |
| **Contradiction Resolution (CR)** | `40/40` | **`85.94%`** | **`92.50%`** | `78.13%` | `75.36%` |
| **Abstention (ABS)** | `40/40` | `61.25%` | `67.50%` | `98.75%` | `97.14%` |
| **Multi-Session Reasoning (MSR)** | `40/40` | `58.44%` | `54.87%` | `68.95%` | `72.82%` |
| **Instruction Following (IF)** | `40/40` | `69.38%` | `71.88%` | `96.25%` | `96.43%` |
| **Preference Following (PF)** | `40/40` | `91.88%` | `85.00%` | `100.00%` | `98.87%` |
| **Summarization (SUM)** | `40/40` | `77.46%` | `90.46%` | `99.38%` | `99.60%` |
| **FULL 10-CAT E2E QA MEAN (`400/400`)** | **`400/400`** | **`64.26%`** | **`70.60%`** | **`92.08%`** | **`90.65%`** |

#### Published `Mohammadta/BEAM` (`100K`, `n = 400`) Overall Leaderboard Context

| System / Architecture | Deployment & Model Regime | Judging Protocol | Full `100K` (`n = 400`) E2E Score |
| :-------------------- | :------------------------ | :--------------- | :-------------------------------: |
| **`past.dev`** | Proprietary Cloud (`openai/gpt-5.6-luna`) | Self-judged (`gpt-5.6-luna`) | `92.08%` |
| **`Hindsight`** | Cloud Memory Service | BEAM Judge | `86.20%` |
| **`Exabase M-1`** | Cloud Memory Service | BEAM Judge | `76.90%` |
| **`krusch-context-mcp v1.9.0` (`bge-large` `512` ctx)** | **Single-Box Closed System (`gpt-oss:120b`, `8K` budget)** | **Cross-Family (`hermes3:latest`)** | **`73.53%`** |
| **`krusch-context-mcp v1.9.0` (`snowflake-arctic-embed2` `8K` ctx)** | **Single-Box Closed System (`gpt-oss:120b`, `8K` budget)** | **Cross-Family (`hermes3:latest`)** | **`70.60%`** |
| **`krusch-context-mcp v1.8.1` (`bge-large` `512` ctx)** | Single-Box Closed System (`gpt-oss:120b`, `8K` budget) | Cross-Family (`hermes3:latest`) | `69.19%` |
| **`krusch-context-mcp v1.9.0` (`bge-large` `512` ctx)** | **Single-Box Closed System (`gpt-oss:120b`, `8K` budget)** | **Cross-Family (`qwen2.5:32b`)** | **`67.19%`** |
| **`krusch-context-mcp v1.9.0` (`snowflake-arctic-embed2` `8K` ctx)** | **Single-Box Closed System (`gpt-oss:120b`, `8K` budget)** | **Cross-Family (`qwen2.5:32b`)** | **`64.26%`** |
| **`krusch-context-mcp v1.8.1` (`bge-large` `512` ctx)** | Single-Box Closed System (`gpt-oss:120b`, `8K` budget) | Cross-Family (`qwen2.5:32b`) | `63.92%` |
| **`Honcho`** | Cloud Conversational Memory | BEAM Judge | `63.00%` |
| **`MEMIR`** *(Jin et al., 2026)* | Academic Baseline | BEAM Judge | `48.26%` |

---

### Table C: Controlled `400/400` Ablation (`v1.9.0` + `snowflake-arctic-embed2`) — Stock `gpt-oss:120b` vs. `krush420/gpt-oss-120b-sre-lora` (QLoRA)

> *Evaluates the exact same `v1.9.0` `unifiedRetrieve` + `snowflake-arctic-embed2:latest` contexts and blind Reader/Judge prompts after fusing our 144-pair (`r=16, alpha=32`) `BF16` SRE attention adapter ([`krush420/gpt-oss-120b-sre-lora`](https://huggingface.co/krush420/gpt-oss-120b-sre-lora)) directly into `gpt-oss:120b` in `2.00s` (`3,313.8s` full `400/400` wall time).*

| BEAM Memory Category (`n = 40` each) | Stock `120B` (`qwen2.5:32b`) | **QLoRA `120B-SRE` (`qwen2.5:32b`)** | $\Delta$ (`qwen2.5:32b`) | Stock `120B` (`hermes3`) | **QLoRA `120B-SRE` (`hermes3`)** | $\Delta$ (`hermes3`) |
| :----------------------------------- | :--------------------------: | :----------------------------------: | :----------------------: | :----------------------: | :------------------------------: | :------------------: |
| **Information Extraction (IE)** | `68.59%` | **`69.53%`** | **`+0.94 pp`** | `70.63%` | **`73.75%`** | **`+3.12 pp`** |
| **Knowledge Update (KU)** | `37.50%` | **`38.75%`** | **`+1.25 pp`** | `47.50%` | **`52.50%`** | **`+5.00 pp`** |
| **Temporal Reasoning (TR)** | **`82.50%`** | `68.75%` | `-13.75 pp` | **`82.50%`** | `67.50%` | `-15.00 pp` |
| **Event Ordering (EO)** | **`9.68%`** | `7.64%` | `-2.04 pp` | **`43.17%`** | `36.50%` | `-6.67 pp` |
| **Contradiction Resolution (CR)** | **`85.94%`** | `85.00%` | `-0.94 pp` | `92.50%` | **`98.13%`** | **`+5.63 pp`** |
| **Abstention (ABS)** | **`61.25%`** | `60.00%` | `-1.25 pp` | **`67.50%`** | `65.00%` | `-2.50 pp` |
| **Multi-Session Reasoning (MSR)** | **`58.44%`** | `57.69%` | `-0.75 pp` | `54.87%` | **`62.87%`** | **`+8.00 pp`** |
| **Instruction Following (IF)** | **`69.38%`** | `61.25%` | `-8.13 pp` | **`71.88%`** | `68.75%` | `-3.13 pp` |
| **Preference Following (PF)** | **`91.88%`** | `90.63%` | `-1.25 pp` | `85.00%` | **`89.38%`** | **`+4.38 pp`** |
| **Summarization (SUM)** | **`77.46%`** | `68.73%` | `-8.73 pp` | **`90.46%`** | `75.92%` | `-14.54 pp` |
| **FULL 10-CAT MEAN (`n = 400/400`)** | **`64.26%`** | `60.80%` | `-3.46 pp` | **`70.60%`** | `69.03%` | `-1.57 pp` |

---

## 5. Architectural Diagnosis: Residual Gaps & Open-Weights Tradeoffs (`v1.9.0`)

Excluding `Event Ordering` and `Knowledge Update`, unmodified Stock `gpt-oss:120b` averages **`74.43%`** on `qwen2.5:32b` and **`76.92%`** on `hermes3:latest` under `snowflake-arctic-embed2:latest` (`76.99%` / `79.72%` under `bge-large`) across the remaining `320/400` questions. Three domain-honest structural boundaries account for the remaining gap to cloud `gpt-5.6-luna`:

1. **Strict Exact-Count `Event Ordering (EO)` (`79.88%` Recall $\rightarrow$ `9.68%` `qwen2.5:32b` / `43.17%` `hermes3`)**:
   - Upgrading to `snowflake-arctic-embed2` lifted `EO` `Recall@10` (`17.42%` $\rightarrow$ **`22.63%`**), `Recall@20` (`30.81%` $\rightarrow$ **`37.00%`**), `Dense 8K` (`72.28%` $\rightarrow$ **`75.04%`**), and E2E QA (`8.51%` $\rightarrow$ **`9.68%`** Qwen; `36.25%` $\rightarrow$ **`43.17%`** Hermes).
   - However, BEAM `EO` rubrics require listing *"ONLY and ONLY three [or five] macro-events"* across 140+ turns without merging or splitting sub-topics; any count mismatch (`4` items vs `3`) is strictly graded `0.0` by `qwen2.5:32b`.
2. **Passive Blind Ingestion vs. Explicit `supersede` Lineage on `Knowledge Update (KU)` (`97.50%` Recall $\rightarrow$ `37.50%` Stock / `38.75%` QLoRA on `qwen2.5:32b`, `52.50%` QLoRA on `hermes3`)**:
   - Under `ARCH-05` uniform blind ingestion (`category = 'decision'`, `supersedes_id = NULL`), asymmetric `query:` retrieval boosts `KU` `Recall@10` to **`87.50%`** (`+2.50 pp`), surfacing *both* the superseded initial turn and the final state-mutation turn into the `680`-char Tier-1 prompt window. Without explicit `krusch_context_revise(action: "supersede")` lineage (which production IDE agents invoke directly), the Reader must adjudicate competing historical turns purely from turn numbers.
3. **Remaining Scope Boundary (`1M` / `10M` Splits)**:
   - Only the official `100K` split (`20` conversations, `~3.06M` corpus tokens, `400` questions) has been evaluated to date; `1M` and `10M` splits remain future work.

---

## 6. Reproducibility Commands

```bash
# 1. Run all 80 unit, contract, and honesty regression tests (100% SQLite, zero Docker)
npm test

# 2. Verify SHA-256 provenance, zero oracle leakage, turn-ID recall math & Dual Judge tallies (all 400 Qs)
npm run bench:beam:verify
node benchmarks/verify_zero_leakage.js --audit-log=benchmarks/g4_closed_system/beam_100k_qlora_full400_audit_log.json

# 3. Reproduce the entire hermetic single-box Closed-System 400/400 + QLoRA A/B run on Colab G4 (96GB Blackwell)
./scripts/run_beam_closed_g4.sh

# 4. Run locally against any loopback Ollama instance (127.0.0.1:11434)
EMBED_MODEL=snowflake-arctic-embed2:latest \
OLLAMA_EMBED_NUM_CTX=8192 \
READER_MODEL=gpt-oss:120b \
OLLAMA_JUDGE_MODEL=qwen2.5:32b \
OLLAMA_SECONDARY_JUDGE_MODEL=hermes3:latest \
node scripts/benchmark_official_beam.js --full-judge
```

---

## 7. Controlled Embedding & Version Progression: `v1.8.1 (bge-large)` $\rightarrow$ `v1.9.0 (bge-large)` $\rightarrow$ `v1.9.0 (snowflake-arctic-embed2)` (`n = 400/400` Closed-System G4)

All three closed-system campaigns were executed on identical **96 GB NVIDIA RTX PRO 6000 Blackwell** instances against the exact same dataset SHA-256 (`d542da9e...`), identical turn-slicing (`900`/`600` chars, `1,800` max chunk), and identical Reader/Judge model digests (`gpt-oss:120b` `714d8695...`, `qwen2.5:32b` `9f13ba12...`, `hermes3:latest` `4f6b83f3...`), cleanly separating **retrieval-engine upgrades** from the **embedding-model cutover**:

1. **Retrieval Engine Upgrade (`v1.8.1` $\rightarrow$ `v1.9.0`, holding `bge-large:latest` fixed)**:
   - Added compact binary `Float32Array` vector blobs (`embedding_blob`), external-content Porter-stemmed SQLite `FTS5`, passive `Chronological State Evolution` (`detectTemporalUpdates`), corpus-wide `Lexical Grounding Note` (`computeCorpusUnattestedTerms`), top-placed 24-milestone `Chronological Event Sequence`, and speech-act directive stratification.
   - Lifted 9-cat `Packed 8K` recall from `91.99%` $\rightarrow$ **`92.97%`** (`+0.98 pp`), `Recall@10` from `52.43%` $\rightarrow$ **`54.20%`** (`+1.77 pp`), and Stock `gpt-oss:120b` E2E QA from `63.92% / 69.19%` $\rightarrow$ **`67.19% / 73.53%`** (`+3.27 pp` / `+4.34 pp`).
2. **Embedding Model Upgrade (`v1.9.0` `bge-large:latest` `512` ctx $\rightarrow$ `snowflake-arctic-embed2:latest` `8,192` ctx + `calibrateQuerySimilarity`)**:
   - **Cold-Room Speed & Long-Turn Dense Recall**: Cut `3,266`-record cold-room embedding time by **`23.1%`** (`52.85s` $\rightarrow$ **`40.62s`**) while raising pure `Dense 8K` recall from `91.48%` $\rightarrow$ **`92.41%` (`+0.93 pp`)** (`Summarization +5.47 pp`, `Event Ordering +2.76 pp`, `Multi-Session Reasoning +1.05 pp`).
   - **Top-K Fixed-Rank Precision Surge**: Lifted `Hybrid Recall@10` from `54.20%` $\rightarrow$ **`57.69%` (`+3.49 pp`)**, `Recall@20` from `68.11%` $\rightarrow$ **`70.88%` (`+2.77 pp`)**, and `Recall@30` from `76.67%` $\rightarrow$ **`78.04%` (`+1.37 pp`)** — critical for production IDE sessions where `limit_tokens = 4000` packs `~15–30` memories rather than `68`.
   - **Per-Category E2E Tradeoff**: Improved **Contradiction Resolution** (`+6.25 pp` Qwen / `+7.50 pp` Hermes to **`85.94% / 92.50%`** Stock and **`98.13%`** QLoRA), **Summarization** (`+12.27 pp` Hermes to **`90.46%`**), **Temporal Reasoning** (`+3.75 pp` / `+2.50 pp` to **`82.50%`**), **Event Ordering** (`+1.17 pp` / `+6.92 pp` to **`9.68% / 43.17%`**), and **Preference Following** (`+0.63 pp` Qwen to **`91.88%`**), while surfacing stronger semantic distractors on un-superseded `Abstention`, `Knowledge Update`, and `Information Extraction` probes (`-2.93 pp` overall E2E mean).

| BEAM Memory Category (`40/40` Qs each) | `v1.9.0` `bge-large` `R@10` / `8K` | **`v1.9.0` `arctic-embed2` `R@10` / `8K`** | `v1.9.0` `bge-large` Stock E2E (`32B` / `8B`) | **`v1.9.0` `arctic-embed2` Stock E2E (`32B` / `8B`)** | $\Delta$ `R@10` / $\Delta$ Stock E2E (`32B` / `8B`) |
| :------------------------------------- | :--------------------------------: | :----------------------------------------: | :-------------------------------------------: | :---------------------------------------------------: | :-------------------------------------------------: |
| **Information Extraction (IE)** | `60.42%` / `95.00%` | **`60.42%` / `93.75%`** | `77.08%` / `80.21%` | `68.59%` / `70.63%` | `0.00 pp` / `-8.49 pp` / `-9.58 pp` |
| **Knowledge Update (KU)** *(Canary = 0)* | `85.00%` / `97.50%` | **`87.50%` / `97.50%`** | `47.50%` / `61.25%` | `37.50%` / `47.50%` | **`+2.50 pp`** / `-10.00 pp` / `-13.75 pp` |
| **Temporal Reasoning (TR)** | `88.75%` / `100.00%` | **`95.00%` / `100.00%`** | `78.75%` / `80.00%` | **`82.50%` / `82.50%`** | **`+6.25 pp` / `+3.75 pp` / `+2.50 pp`** |
| **Event Ordering (EO)** | `17.42%` / `80.08%` | **`22.63%` / `79.88%`** | `8.51%` / `36.25%` | **`9.68%` / `43.17%`** | **`+5.21 pp` / `+1.17 pp` / `+6.92 pp`** |
| **Contradiction Resolution (CR)** | `79.17%` / `100.00%` | **`81.67%` / `100.00%`** | `79.69%` / `85.00%` | **`85.94%` / `92.50%`** | **`+2.50 pp` / `+6.25 pp` / `+7.50 pp`** |
| **Abstention (ABS)** | `—` | `—` | `73.75%` / `85.00%` | `61.25%` / `67.50%` | `—` / `-12.50 pp` / `-17.50 pp` |
| **Multi-Session Reasoning (MSR)** | `55.63%` / `90.59%` | **`55.85%` / `91.42%`** | `64.17%` / `64.81%` | `58.44%` / `54.87%` | **`+0.22 pp`** / `-5.73 pp` / `-9.94 pp` |
| **Instruction Following (IF)** | `43.96%` / `100.00%` | **`53.13%` / `98.75%`** | `71.25%` / `76.88%` | `69.38%` / `71.88%` | **`+9.17 pp`** / `-1.87 pp` / `-5.00 pp` |
| **Preference Following (PF)** | `37.61%` / `96.58%` | **`42.31%` / `95.30%`** | `91.25%` / `87.71%` | **`91.88%`** / `85.00%` | **`+4.70 pp` / `+0.63 pp`** / `-2.71 pp` |
| **Summarization (SUM)** | `19.89%` / `76.96%` | **`20.67%` / `74.70%`** | `79.94%` / `78.19%` | `77.46%` / **`90.46%`** | **`+0.78 pp`** / `-2.48 pp` / **`+12.27 pp`** |
| **OVERALL MEAN (`360` Recall / `400` E2E)** | `54.20%` / `92.97%` | **`57.69%` / `92.37%`** | `67.19%` / `73.53%` | **`64.26%` / `70.60%`** | **`+3.49 pp` (`R@10`)** / `-2.93 pp` / `-2.93 pp` |
