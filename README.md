# codeindex

**English** · [Português](README.pt-BR.md)

**Local, zero-API code retrieval + AST-anchored edits for coding agents — TypeScript-native.**
Give it a task string, get back the exact files and line-ranges that matter (no
API calls on the query path). Then let an agent change code by emitting structural
ops against AST anchors that only land if they still type-check.

> [!NOTE]
> **This is a case study, not a product.** A weekend experiment to see whether
> indexing a codebase beats agents grepping non-stop. It works and the numbers are
> real, but expect rough edges — there's no roadmap, support, or stability
> commitment. Things may change or improve; equally, they may not.
>
> **Built with heavy AI assistance (Claude Code).** The idea, direction, and
> decisions are mine; a lot of the implementation and all the benchmark harnesses
> were written with Claude. Treat the code as reviewed-but-AI-generated.

## Why

Agents burn a lot of tokens grepping non-stop and spinning up throwaway scripts
just to *find* the code to touch — and then re-emit big diffs to *change* it. I
wanted to see how far a proper local index + AST-aware edits could cut that. I work
mostly in Node/TS, so I leaned into TypeScript's own tooling, and I'm used to
monorepos, where a shared package imported everywhere can wreck semantic relevance.

## What it does

**Find code** — a hybrid index fusing BM25 (lexical) + dense vectors + exact
symbol-name matches with reciprocal rank fusion, then expansion along the *import
graph*. Monorepo-aware (package weighting leans the rank toward the layer the query
is actually about). Runs fully in-process — one embedding per query, no API.

**Change code** — instead of re-emitting files or spraying str_replace patches, an
agent emits structural ops (`RENAME` / `SET_BODY` / `REPLACE_TEXT` / `INSERT_BEFORE`)
against AST anchors. A ts-morph runner applies them behind a **type-check gate**:
nothing lands unless it still compiles, and failures roll back (or scoped-repair).

## Numbers (on my own repos — honest baselines)

- **Finding code:** ~55–84% fewer input tokens than grep-and-read. A real agent on
  the same task read ~2.4× less with the index than without — same answer.
- **Changing code:** a multi-file rename went from a real agent's ~312 tokens of
  str_replace edits to one ~16-token directive (~19×). *Honest:* that's the refactor
  case — one-line tweaks and brand-new code are roughly a wash; the win there is the
  type-check gate, not tokens.
- **Embedder:** started on `bge-small`; ported MinishLab's `potion-code-16M`
  (Model2Vec) to run native in Node → ~80× faster indexing, output verified
  bit-for-bit against the Python reference (cosine 1.0).

Full methodology, every number, and **where it loses** → [docs/benchmarks.md](docs/benchmarks.md).

## Try it

```bash
npm install
npm run index    -- --root /path/to/your/repo          # build the index
npm run retrieve -- "add rate limiting to uploads" --root /path/to/your/repo --json
```

Benchmarks (all reproducible):

```bash
npm run benchmark -- /path/to/repo "<task>"   # input-token savings
npm run bench:e2e        # output tokens, executed end-to-end
npm run bench:embedder   # bge-small vs potion-code
npm run test:edit        # edit-ops correctness + rollback
```

## How it works

| Doc | Covers |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | The retrieval pipeline, component by component |
| [docs/ast-edit-protocol.md](docs/ast-edit-protocol.md) | The AST-anchored edit layer (`src/edit/`) |
| [docs/benchmarks.md](docs/benchmarks.md) | Every number + how it was measured |
| [docs/roadmap.md](docs/roadmap.md) | Ideas & known gaps (notes, **not** commitments) |
| [RESULTS.md](RESULTS.md) | The short, shareable results summary |

## Credits

The retrieval approach is the same idea as **[Semble](https://github.com/MinishLab/semble)**
by **MinishLab** — static Model2Vec embeddings + BM25 + RRF for code search. I
started on `bge-small`, went looking for something faster, and found their work,
which both validated the idea and led me to adopt their `potion-code-16M` model (I
wrote a small Node port since it wasn't available there). Semble is
**language-agnostic** (tree-sitter); this is **TS-only on purpose**, to lean on
TypeScript inference. If you're not in TS-land, Semble is your move.

Also built on [Model2Vec](https://github.com/MinishLab/model2vec) ·
[potion-code-16M](https://huggingface.co/minishlab/potion-code-16M) · `ts-morph` ·
`@xenova/transformers`.

## Caveats

- **TypeScript / TSX only** (it's built on the TS compiler API).
- Quality numbers come from small labeled sets — directional, not benchmarks of record.
- Sample-grade code: tested where it counts, but not hardened for production.

## License

[MIT](LICENSE) — use it however you like. No warranty; it's a sample.
