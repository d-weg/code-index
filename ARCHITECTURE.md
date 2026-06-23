# codeindex — Architecture & How It Works

> 🇧🇷 Este documento está em inglês. Visão geral em português:
> [README.pt-BR.md](README.pt-BR.md) · resultados: [RESULTS.pt-BR.md](RESULTS.pt-BR.md).

A local, **zero-API-token** code-retrieval system. Given a task string (`"add rate
limiting to the upload route"`) it returns a compact **context manifest** — the relevant
files, the specific symbol line-ranges to read, and how each file relates to the task —
computed entirely on local hardware. No LLM/API calls on the query path; the only model is
a small embedding model that runs in-process via ONNX.

The design principle is **front-load the heavy work**. All expensive computation (parsing,
embedding, graph building) happens once, offline, into a static index. The query path is
pure local arithmetic over that index, so it's fast, free, and private.

---

## 1. Two phases

```
        ┌──────────────────── OFFLINE (index.ts) ─────────────────────┐
        │                                                              │
  repo ─┤ workspace detect → ts-morph parse → symbol table            │
        │                                   └→ import graph            │   .codeindex/
        │                  symbol-chunks ───→ dense embeddings (ONNX)  ├──▶ (static index)
        │                                   └→ BM25 lexical index      │
        └──────────────────────────────────────────────────────────────┘
                                                                          │
        ┌──────────────────── QUERY (retrieve.ts) ────────────────────┐  │
        │  ZERO API CALLS                                              │◀─┘
  task ─┤ embed query (ONNX) ─┐                                        │
        │ BM25 search ─────────┼─→ Reciprocal Rank Fusion (k=60)       ├──▶ manifest
        │ symbol-name match ───┘        → top-N seed files             │   (JSON +
        │                               → expand 1–2 hops (import graph)│    summary)
        │                               → +adjacency bonus, cap, sort   │
        └──────────────────────────────────────────────────────────────┘
```

- **Offline** (`index.ts` → `indexer.ts`): builds and persists the index. Re-run in full, or
  incrementally via `--update <files>` (what the git hook calls).
- **Query** (`retrieve.ts`): task in, manifest out. Touches only the persisted index plus
  the in-process embedder. No network.

---

## 2. The pipeline, component by component

### 2.1 Workspace detection — `workspace.ts`

Before anything is parsed, the repo is classified as single-package or monorepo, because
import resolution and symbol ownership depend on *which `tsconfig`* a file belongs to.

- **Monorepo signals:** a `workspaces` field in root `package.json`, a `pnpm-workspace.yaml`
  (parsed with a minimal block reader), or the presence of `turbo.json` / `nx.json`.
- For each workspace glob, `fast-glob` finds the package dirs (those with a `package.json`),
  and each package's own `tsconfig.json` is resolved (falling back to the root config).
- `packageForFile()` maps any file to its owning package by **longest-matching directory
  prefix**, so `apps/backend/src/x.ts` is owned by `backend`, not the root.

Each package is also classified with a **role** (`backend | frontend | mobile | shared | docs`)
inferred from its dependencies / tsconfig (see §6.1), persisted on `PackageInfo.role`. Every
symbol is tagged with its owning package name — this, plus the role, is the hook
package-weighted ranking uses (see §6.1).

### 2.2 Symbol table — `symbols.ts` (ts-morph)

We use **ts-morph** (a typed wrapper over the TypeScript compiler API), not tree-sitter,
because it understands TS *semantics*: exports, JSDoc, and — critically — symbol resolution
through re-exports.

Per source file we extract: **functions, classes, methods, interfaces, type aliases, enums,
exported consts, and function-valued top-level consts**. That last category matters: backend
code commonly defines its logic as non-exported arrow functions aggregated into a
default-exported object (`const createUnlock = async () => {…}` … `export default { createUnlock,
… }`). Indexing only *exported* consts misses all of it — on the test repo backend that left the
entire service layer invisible (14/68 backend files indexed; `unlocks.service.ts`, the file a
"deduct a credit on unlock" task is *about*, contributed zero chunks). We therefore index any
top-level const whose initializer is an arrow function / function expression regardless of
export (it carries real implementation), while keeping the export-only rule for plain-value
consts so the index isn't flooded with private literals. This lifted backend coverage to 42/68
files and is what makes package-aware ranking (§6.1) have something to rank.

For each symbol we capture:

- `name`, `kind`, `file`, owning `pkg`
- `startLine` / `endLine` — `getStartLineNumber(true)` includes leading JSDoc, so the
  retrieved range carries the doc comment
- `doc` — JSDoc (`getJsDocs()`) or a leading-comment fallback
- a short `signature` line for the human summary

Each symbol becomes one **chunk** whose embed/search text is
`"{kind} {name}\n{doc}\n{first ~1500 chars of the body}"`. One chunk per symbol keeps
embeddings tight and lets the manifest point at precise line-ranges instead of whole files.

**Barrel detection** (`isBarrelFile`): a module that is mostly `export … from "…"` is flagged
so the graph can treat it as a pass-through (see §2.3).

### 2.3 Import graph — `import-graph.ts`

The graph is what lets the manifest expand from "files that match the words" to "files that
are *structurally* involved." Two adjacency lists are built:

- **forward**: `file → files it imports`
- **reverse**: `file → files that import it` (derived from forward)

The hard part is resolving an import to the **true definition site**, not the literal module
string. For each `import` declaration:

1. For each named/default/namespace import, get its symbol and **follow the alias chain**
   (`getAliasedSymbol`, looped to a fixed point). This is what resolves **barrel
   re-exports**: `import { Foo } from "./index"` where `index.ts` re-exports `Foo` from
   `foo.ts` produces an edge **A → foo.ts** (the real definition), *not* A → the barrel. So
   graph expansion never surfaces every barrel-connected file as a false positive.
2. If alias resolution finds nothing indexed, fall back to the module-specifier's source file.
3. **Cross-package fallback:** if the specifier is a workspace package (`@scope/pkg`) whose
   source we indexed but resolution landed in `dist`/`node_modules`, the named imports are
   re-mapped to that package's source by symbol name (via a `pkgName → name → files` index).

This gives *real* resolution: tsconfig path aliases, ESM `.js`-extension imports, barrels,
and cross-package workspace imports all resolve to actual source files.

### 2.4 Dense embeddings — `embeddings.ts` (transformers.js / ONNX)

Each chunk's text is embedded with **`Xenova/bge-small-en-v1.5`** running in-process through
**transformers.js** (ONNX runtime) — no Python, no service, no API. The model is downloaded
once to the HuggingFace cache on first run, then everything is offline.

- Pooling = `mean`, `normalize = true` → unit vectors, so **cosine similarity == dot product**.
- Vectors (384-dim) are stored as a single flat `Float32Array` matrix (`N × dims`), row-aligned
  with the chunk metadata. No external vector DB — at codebase scale a flat matrix scan is fine.
- The **query** is embedded with the bge retrieval instruction prefix
  (`"Represent this sentence for searching relevant code: "`), which the model expects for
  asymmetric query↔document search.

### 2.5 BM25 lexical index — `bm25.ts`

Dense vectors capture meaning; BM25 captures *exact tokens* (an identifier the task names
verbatim). Both matter, so both run.

- **Tokenization is camelCase-aware:** `buildIndex` yields `build`, `index`, *and*
  `buildindex` — so a query word matches identifiers regardless of casing convention.
  Stopwords are dropped.
- Standard BM25 (`k1=1.5`, `b=0.75`), with `idf = ln(1 + (N − n + 0.5)/(n + 0.5))`.
- **Incremental:** docs can be added/removed by file, so `--update` doesn't rebuild it.

### 2.6 Persistence — `store.ts`

The index is a directory, `.codeindex/`:

| File | Contents |
|---|---|
| `meta.json` | model, dims, package list, per-file `{mtime, pkg}`, timestamps |
| `symbols.json` | the full symbol table (`SymbolEntry[]`) |
| `chunks.json` | chunk metadata, row-aligned with the embedding matrix |
| `embeddings.bin` | raw `Float32Array` (`N × dims`), little-endian |
| `graph.json` | the **forward** adjacency map (reverse is derived on load) |
| `bm25.json` | serialized BM25 (docs + document frequencies) |
| `config.snapshot.json` | the config used, for reproducibility |

---

## 3. The query path in detail — `retrieve.ts`

This is the whole value proposition, and it makes **zero API calls**.

1. **Embed the query** locally (with the retrieval prefix).
2. **Three independent searches**, each producing a ranked list of *files*:
   - **Vector**: score every matrix row by cosine, take the top rows, dedupe to files
     (best chunk wins). The top rows also seed each file's `matchedSymbols` (with line-ranges).
   - **BM25**: lexical search over chunk text → files.
   - **Symbol-name**: direct overlap of query tokens against symbol *names* (+ a bonus when
     the query string literally contains a symbol name). Catches "I know the function is
     called X" even with no prose match.
3. **Reciprocal Rank Fusion** — `rrf.ts`. Merge the three lists with
   `score(file) = Σ 1/(k + rank)`, `k = 60`. RRF is parameter-free and robust: it rewards
   files that rank well across *multiple* signals without needing to calibrate score scales.
3b. **Package weighting**: multiply each file's fused score by its owning package's weight
   (static config + query-conditioned layer boost) so relevance can be biased toward the
   layer a task is about — applied here, before seed selection, so it steers which files
   become seeds. See §6.1.
4. **Seeds**: the top-`N` weighted-fused files (default 8). Their order is returned on the
   manifest as `seedRanking` (diagnostic — what package weighting steers).
5. **Graph expansion**: from the seeds, walk the import graph **1–2 hops in both directions**:
   - `forward[seed]` → files the seed imports → tagged **`imported-by-seed`**
   - `reverse[seed]` → files that import the seed → tagged **`imports-seed`**
6. **Scoring + adjacency bonus**: every candidate's final score is
   `fusedScore + adjacencyBonus × (#seeds it is import-adjacent to)`. A file that is *both*
   semantically matched *and* structurally adjacent ranks above a single-signal file — which
   is exactly what you want.
7. **Cap the expansion** (`maxExpand`, default 10): seeds are always kept; graph-expanded
   files are ranked by final score and only the top `maxExpand` survive. **This is the guard
   against over-expansion on dense import graphs** — without it, a heavily-connected app (e.g.
   an Expo project where every screen imports the shared shell) floods the manifest with
   weakly-related neighbors. (This cap was added after the test repo benchmark surfaced a 91-file
   manifest; see §5.)
8. **Emit the manifest**: each entry carries `file`, `pkg`, `matchedSymbols`
   (`{name, kind, lineRange}`), a `reason` (`query-match | imports-seed | imported-by-seed |
   doc`), and the `score`. Files ≤ 50 lines are flagged `wholeFile` (just read it all); larger
   files are meant to be read at their `matchedSymbols` ranges. Output is both JSON (for piping
   to an agent) and a human summary.

### Manifest entry

```jsonc
{
  "file": "apps/backend/src/features/bids/bids.service.ts",
  "pkg": "backend",
  "matchedSymbols": [{ "name": "acceptBid", "kind": "function", "lineRange": [42, 88] }],
  "reason": "query-match",     // | imports-seed | imported-by-seed | doc
  "score": 0.241,
  "wholeFile": false
}
```

---

## 4. Incremental update & the git hook

### Incremental update — `indexer.ts` `updateFiles()`

`index.ts --update <files>` re-indexes only what changed:

1. Classify inputs as changed-TS, changed-doc, or deleted.
2. Re-parse changed TS files **through their owning package's `tsconfig`** (so path aliases
   and cross-package resolution stay correct — a file parsed under the wrong config gets its
   imports wrong).
3. Remove old symbols/chunks/BM25 docs/forward-edges for the affected files; append the new
   ones; **re-embed only the new chunks**.
4. Rebuild the embedding matrix by keeping unaffected rows and appending the new vectors.
5. Recompute forward edges for changed files; prune deleted files everywhere.
6. Update `meta.json` mtimes and rewrite the index.

### Git hook — `scripts/install-hooks.ts` → `post-commit`

`npm run install-hooks -- /path/to/repo` writes a `post-commit` hook that:

- Lists committed `.ts/.tsx/.md` files via `git diff-tree --no-commit-id --name-only -r HEAD`.
- Runs `index.ts --update` on just those files — **incremental, never a full rebuild**.
- Runs **backgrounded/detached**, so it never blocks the commit; logs to `.codeindex/update.log`.

A `PostToolUse`-style safety net isn't needed here — the indexer is greenfield-safe and the
hook is a no-op when nothing relevant changed.

---

## 5. How it was validated (benchmark)

`scripts/benchmark.ts` measures context-gathering token cost **with vs. without** the index on
a single task, two ways:

- **(a) narrowing only** — baseline = the manifest's files read *whole*; with = their targeted
  ranges. This *undersells* the tool (graph-expanded files have no ranges, so they're whole in
  both columns), but it's a hard floor.
- **(b) realistic** — baseline = a naive agent greps the task's keywords and reads every hit
  *whole*; with = the focused manifest. This is the real comparison: what an agent burns
  *finding* context without an index.

Token figures use a `chars/4` estimate (labeled); the **% reduction is divisor-independent**,
so the headline is robust regardless of the exact tokenizer.

**Findings on the test repo monorepo (175 files):** the benchmark first exposed an over-expansion
defect (91-file manifests) which motivated the `maxExpand` cap in §3.7. After the fix, across
four realistic backend/mobile tasks, baseline (b) showed **~50–85% reduction** (avg ~66%) in
context-gathering tokens, with focused 18-file manifests. The conservative baseline (a) was
2–35% on the same tasks. The realistic number is the one to quote, with the caveat that it
scales with how broad the task keywords are.

---

## 6. Ranking & tuning roadmap (separate work)

The retrieval *plumbing* is solid; **relevance ranking is the next tuning surface**. The test repo
benchmark surfaced a concrete weakness: for backend-logic tasks, results leaned **mobile-heavy**
— there are simply more mobile files and the prose terms overlap, so the backend service file
that actually implements the logic ranked lower than UI files that merely mention it.

### 6.1 Package-type / package-weight ranking — **IMPLEMENTED** (`package-weight.ts`)

**Goal:** bias the fusion by which package a symbol lives in, because relevance is
package-dependent — a "transaction" task should favor `backend`, a "screen layout" task should
favor `mobile`. Every symbol is tagged with its owning `pkg` (§2.1), so the hook exists.

**What shipped.** A per-package multiplier on the fused score, composed from two levers
(`computePackageWeights`):

1. **Static per-package / per-role weights** — `config.packageWeights`, a map keyed by package
   *name* or *role* (`{ backend: 1.3, mobile: 0.9 }`). The simplest viable lever; a per-repo
   floor. Empty by default.
2. **Query-conditioned layer weighting** (default on, `config.queryLayerWeighting`) — classify
   each package into a **role** (`backend | frontend | mobile | shared | docs`). The role is
   inferred **from the package's dependencies** (`elysia`/`drizzle-orm`/`@aws-sdk/*` ⇒ backend,
   `next`/`react-dom` ⇒ frontend, `expo`/`react-native` ⇒ mobile), with tsconfig hints
   (`types: ["bun-types"]` ⇒ backend, `lib: ["dom"]` ⇒ frontend) and a name/dir substring as
   last-resort fallbacks — *not* by matching the package name, which is brittle. This is done
   once at index time (`workspace.ts`) and persisted on `meta.packages[].role`, so the query
   path does no filesystem work; overridable with `config.packageRoles`. Then infer the query's target
   layer from its terms (`route/transaction/schema/atomic/presign/credit…` → backend;
   `screen/layout/component/tap/gesture…` → mobile), and boost the matching role's packages for
   *this query only*: `mult = 1 + boost · (layerHits / maxLayerHits)`. Repo-agnostic — it keys
   off inferred roles, not hardcoded package names — so it's the default.

The two compose multiplicatively: `weight[pkg] = static[pkg] × queryConditioned[pkg]`.

**Decision — apply the weight POST-RRF (on the fused score), not per-signal pre-fusion.** RRF
contributions are `1/(k+rank)`: rank-based and scale-free by design. Scaling a per-list score
*before* fusion doesn't change an item's rank within that list, so it's nearly a no-op on the
fusion input; to actually re-order you'd have to re-sort each list by weighted score, coupling
the weight to each list's internal scale — the very thing RRF exists to ignore. Multiplying the
single fused score is a clean, monotonic re-rank that steers seed selection directly. It is
applied **before** seed selection so weighting decides *which* files become seeds (retrieve.ts §3b).

**Results (labeled eval, `scripts/eval.ts` — 4 backend + 2 mobile-control tasks).** First, the
symbol-recall fix (§2.2) was the dominant lever: with the backend service layer finally indexed,
all six tasks pass (their target file lands in the seeds) even with weighting off. Package
weighting is then a measurable *ordering* refinement: it improves the average seed-rank of the
target file from **1.33 → 0.83** (lower = better), pulling each query's layer-appropriate file
toward the top of the seeds — backend files up on backend queries, mobile files up on mobile
queries — with **no regression** on the mobile controls. Run both modes:
`CODEINDEX_NO_PKG_WEIGHT=1 npm run eval -- ~/the test repo` vs `npm run eval -- ~/the test repo`. The pure
weighting logic is unit-tested (`npm test`).

**Acceptance — met:** backend service files rank into the seeds for all four backend-logic tasks
(`bids.service`, `storage/index` + `media.service`, `ai/damage-assessment`, `unlocks.service` +
`billings.service`), the two mobile controls still rank their screen/store files into the seeds,
and a labeled eval set measures it.

### 6.2 Other tuning levers (lower priority)

- **Hybrid weighting** of vector vs BM25 vs symbol-name (currently equal via RRF).
- **`maxExpand` / `hops` per repo** — dense graphs may want hops=1; sparse ones tolerate more.
- **Chunk-body length** (currently ~1500 chars) — affects embedding focus vs. recall.
- **Doc handling** — markdown is indexed per heading section; could weight or split differently.

---

## 7. Integration surfaces

The same engine is consumed four ways:

| Surface | Entry | Use |
|---|---|---|
| **CLI** | `index.ts` / `retrieve.ts` | build, query, incremental update from a shell / hook |
| **Library** | `retrieve()`, `buildAll()`, `updateFiles()` | embed in other Node tooling |
| **Function-calling tool** | `tool.ts` (`RETRIEVE_CONTEXT_TOOL` + handler factory) | drop into the Anthropic SDK tool runner |
| **MCP server** | `mcp.ts` (`codeindex-mcp`, stdio) | any MCP-capable agent (Claude Code, internal agents) gets `retrieve_context` for free |

The MCP server is the org-wide distribution path: launch one per repo
(`codeindex-mcp --root <repo>`) and every agent stops over-fetching context.

---

## 8. Module map

| Module | Responsibility |
|---|---|
| `index.ts` | indexer CLI (`--update`) |
| `indexer.ts` | full build + incremental update orchestration |
| `retrieve.ts` | the zero-API query path → manifest |
| `workspace.ts` | monorepo detection, per-package tsconfig, file→package ownership |
| `symbols.ts` | ts-morph symbol extraction + barrel detection |
| `import-graph.ts` | alias/barrel/cross-package import resolution → adjacency lists |
| `embeddings.ts` | in-process ONNX embedder + cosine ranking |
| `bm25.ts` | camelCase-aware BM25 (incremental) |
| `rrf.ts` | Reciprocal Rank Fusion |
| `package-weight.ts` | package-aware ranking: role inference + static & query-conditioned weights (§6.1) |
| `store.ts` | persistence to `.codeindex/` |
| `config.ts` / `types.ts` | config + shared data model |
| `util.ts` | paths, gitignore, glob→regex matching |
| `tool.ts` / `mcp.ts` | function-calling tool + MCP server |
| `scripts/benchmark.ts` | with/without token benchmark (two baselines) |
| `scripts/eval.ts` | labeled ranking eval (task → expected file, seed-rank metric) |
| `scripts/test-package-weight.ts` | unit tests for the pure weighting logic (`npm test`) |
| `scripts/install-hooks.ts` | post-commit hook installer |
