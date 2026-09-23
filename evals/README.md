# Krusch Context Evaluation Suite

This directory contains evaluation fixtures and baseline benchmarks for `krusch-context-mcp`.

> [!NOTE]
> **Preliminary Baseline Notice**:
> The sample sizes in existing fixtures (`corpus_14_ablation.json` with n=14, `express_benchmark_10.json` with n=10) are **preliminary baselines** designed for smoke testing and regression detection during local development. 
> Comprehensive empirical evaluation across foreign held-out repositories is underway.

---

## Benchmark Metrics

Unlike naive Recall@1 retrieval benchmarks, evaluation for coding agents focuses on **Context Window Efficiency**:

1. **Token Budget Containment**:
   Did the packed context contain the necessary rule, invariant, or fact under strict token budgets:
   - `< 1,000 tokens`
   - `< 2,000 tokens`
   - `< 4,000 tokens`
2. **Mean Reciprocal Rank (MRR)**:
   Measures where the authoritative answer sits in the ranked result list.
3. **Citation Completeness**:
   Ensures returned results include verifiable identifiers (`id`, `category`, `provenance`).

---

## Running Benchmarks

```bash
# Run baseline accuracy benchmark
node scripts/benchmark_memory_eval.js
```
