# codeindex — analysis & improvement plan

Grounded review of the current implementation, with a staged plan. Findings cite
`file:line`. Effort = S/M/L, Impact = H/M/L.

## Current state (what's solid)

The core is well-built and doesn't need rework:

- **Hybrid retrieval done right** — BM25 + dense + symbol-name, fused with
  parameter-free RRF (`rrf.ts`), then import-graph expansion with an adjacency
  bonus so "semantically matched *and* import-adjacent" ranks highest
  (`retrieve.ts:198-233`). This is a strong, defensible design.
- **Real import resolution** — tsconfig path aliases, ESM `.js`, and barrel
  re-exports resolved to the true definition site (`import-graph.ts`), so
  expansion doesn't surface barrel false positives.
- **Zero-API query path** — everything runs locally; the only model call is one
  query embedding.
- **Two embedding backends** — transformers.js (`bge-small`) and the new
  Node-native Model2Vec static path (`static-embedder.ts`), parity-verified.
- **Incremental updates + git hook**, package-aware weighting, workspace detection.

## Improvement opportunities

### Architectural

| # | Finding | Where | Effort | Impact |
|---|---|---|---|---|
| A1 | **BM25 has no inverted index** — `search()` linearly scans *every* doc for every query. O(N_docs·Q). Fine now (621 chunks), dominates latency on large repos. Fix: term→postings index, scan only docs containing query terms. | `bm25.ts:92-112` | M | H (at scale) |
| A2 | **Dense search is a full matrix scan** — `rankMatrix` is O(N·dims) per query. Fine ≤ ~10k chunks; needs ANN (HNSW) only beyond that. Scale-gated, not urgent. | `embeddings.ts:rankMatrix` | L→L (HNSW=L) | M (at scale) |
| A3 | **Backend selection is a string heuristic** — `isStaticModel()` + a global `queryEmbedPrefix` that's a bge-ism (potion needs none). Formalize an `Embedder` interface; make the query prefix a property of the backend. Removes a footgun when switching models. | `embeddings.ts` | S | M |
| A4 | **Cold start per CLI call** — every query re-reads + JSON-parses the whole index and (static) loads the 64 MB safetensors. The MCP server amortizes this; the CLI doesn't. Consider mmap for `embeddings.bin` / a warm mode. | `store.ts:loadIndex` | M | M |
| A5 | **Vectors are float32** — int8 quantization (Model2Vec supports it natively) cuts `embeddings.bin` ~4× and memory, with negligible quality loss. Nice for scale *and* the "tiny index" story. | `store.ts` | M | M |

### Code-wise

| # | Finding | Where | Effort | Impact |
|---|---|---|---|---|
| C1 | `data.chunks.find(c => c.file === file)` inside the candidate loop → O(N) within O(M). Precompute a `file→pkg` map once (it's only a fallback; `meta.files` is primary). | `retrieve.ts:216` | S | L |
| C2 | **No unit tests for the ranking core** — `tokenize`, BM25 scoring, RRF are pure and untested. For a public repo, a small suite is worth it. | `bm25.ts`, `rrf.ts` | S | M |
| C3 | Query-prefix coupling (same as A3) is also a code smell: model choice and prefix live in different places. | `config.ts`, `retrieve.ts:111` | S | M |
| C4 | `embedBatch` embeds sequentially; the bge path could batch via transformers.js for faster indexing. (Static path makes this largely moot — another reason to prefer it.) | `embeddings.ts:embedBatch` | S | L |

## Staged plan

Sequenced so each phase ships independently and is separately demoable.

**Phase 1 — Polish & correctness (S, low risk).** C1, C2, C3/A3 (backend interface
+ per-backend prefix). Outcome: cleaner core, tested ranking, no model-switch
footgun. Good first PRs for a public repo.

**Phase 2 — Static embedder as a first-class backend (M).** Finish A3, add int8
quantization (A5), make `potion-code-16M` selectable via config with the prefix
handled automatically. Re-index `the test repo`, run the full eval to confirm quality.
Outcome: ~80× faster indexing, ~4× smaller index, parity-verified.

**Phase 3 — Scale (M, gated on need).** A1 (BM25 inverted index) first — biggest
real latency win — then A4 (warm/mmap load). A2 (ANN) only if a target repo
exceeds ~10k chunks. Outcome: sub-ms queries on large monorepos.

**Phase 4 — Presentation & release (M).** Reproducible presentational benchmark,
charts, public README. (See the benchmark section below.)

## Notes

- A2/A4 are **scale-gated** — don't build them until a real repo needs them;
  premature ANN/daemon work adds complexity the current scale doesn't justify.
- The edit-ops layer (`src/edit/`) is independent and already complete; it's not
  on this retrieval roadmap.
