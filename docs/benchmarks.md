# Benchmarks

> 🇧🇷 Este documento está em inglês. Resumo dos resultados em português:
> [../RESULTS.pt-BR.md](../RESULTS.pt-BR.md).

codeindex cuts the tokens an agent spends on a code task in two places: the
**input** it reads to find context, and the **output** it emits to make the change.
Everything here is from real runs on real repos.

**Honesty rules**
- `token = chars/4` (same as `scripts/benchmark.ts`). The **% reduction is
  divisor-independent**, so it holds under any tokenizer; only absolute counts are
  estimates.
- Each result is tagged: **EXECUTED** (ops actually applied through the ts-morph
  type-check gate), **MODELED** (token accounting of authored artifacts — no live
  model), or **LIVE-AGENT** (a real agent run).
- Two baselines are shown where it matters (a conservative floor + a realistic one)
  so nothing is cherry-picked.

| harness | what |
|---|---|
| `npm run bench:embedder` / `npm run test:parity` | bge-small vs Model2Vec `potion-code-16M`, + the Node port parity |
| `npm run benchmark -- <repo> "<task>"` | input tokens: manifest vs reading/grepping |
| `npm run bench:edit` | output tokens per op type (modeled, over codeindex's own source) |
| `npm run bench:e2e` | output + input, **executed** end-to-end |
| `npm run bench:retry` | big-chunk retry cost (full re-emit vs scoped repair) |
| `npm run bench:feature` | a whole feature applied to an external repo, in-memory |

---

## 1. Embedder — bge-small vs Model2Vec `potion-code-16M`

**Method.** Dense-only retrieval over the `the test repo` index (621 chunks). Same chunk
texts + same 6 labeled queries for both; only the embedder differs. bge runs the
production path (transformers.js); potion via the `model2vec` Python library as a
parity oracle. Metric: rank of the expected file; `pass@8` mirrors the seed budget.

| | bge-small-en-v1.5 | potion-code-16M |
|---|---|---|
| dims | 384 | 256 |
| pass@8 | **6/6** | 5/6 |
| MRR | 0.452 | **0.609** |
| chunk-embed (621) | 16,030 ms | **196 ms** (~82×) |
| query embed (avg) | 6.2 ms | **0.15 ms** (~41×) |

**Read.** Speed is a decisive win; quality is a wash-to-slightly-mixed — potion
(code-specialized) has higher MRR but missed one mobile NL-describes-UI query (rank
33), costing `pass@8`.

**Node-native port (done, EXECUTED).** `src/static-embedder.ts` reimplements
potion's *quantized* inference (`mapping` + `weights`, mean-pool, normalize) in TS,
reusing the tokenizer codeindex already ships (`@xenova/transformers`) and reading
`model.safetensors` directly — no Python at runtime. Verified bit-for-bit vs the
Python reference: **token ids identical, worst-case cosine 1.00000000, max abs
Δ ≈ 7e-9**. `embedText()` routes to it for `isStaticModel` ids.

**Caveats.** 6 cases is *directional only*. Dense-only — production fuses BM25+RRF,
which covers potion's one weak case. **Verdict:** worth it for speed at comparable
quality; gate flipping the default on a larger labeled-set eval.

---

## 2. Input tokens — finding the context

### 2.1 Static benchmark — MODELED (`npm run benchmark`, 3 real tasks on the test repo)

Instead of reading whole files (or grepping and reading every hit), codeindex
returns a manifest of relevant files **with line-ranges**.

| task | WITH index | vs reading right files whole | vs grep-and-read-all |
|---|---|---|---|
| accept a bid (atomic sibling reject) | 13,410 | 17,796 → **25%** | 73,021 → **82%** |
| deduct a credit on unlock | 9,096 | 15,660 → **42%** | 57,303 → **84%** |
| presign R2 + blurred CDN copy | 9,493 | 12,740 → **25%** | 21,008 → **55%** |

- **Conservative floor (25–42%):** assumes the agent already knows the exact files
  and reads them whole — codeindex only adds range-narrowing. Unattackable.
- **Realistic (55–84%):** what an agent burns finding context (grep, then read every
  hit). The manifest's own ~1.1k-token cost is in the WITH column.

### 2.2 Real-agent A/B — LIVE-AGENT

Two read-only agents, same task on the test repo ("add `GET /requests/:id/bid-count`"), one
required to use the codeindex manifest, one restricted to grep/read. Each reported
its own context-gathering tally.

| | WITH codeindex | WITHOUT (grep/read) |
|---|---|---|
| how it found context | 3 `retrieve` calls | 7 grep/find/glob passes |
| distinct files read | ~7–8 | **13** |
| total lines read | **~550** | **~1,331** |
| reached the right answer? | ✅ | ✅ |

**~2.4× less context for the same conclusion.** The without-index agent read four
whole service files it didn't need (`shops`, `unlocks`, `reviews`, `requests`) while
hunting for the pattern — exactly the waste the index removes, and it appeared
unprompted. Both reached the same plan.

**Caveats.** Tallies are **self-reported** and the without-index agent's were
internally inconsistent (claimed 8, listed 13). Both ran as `Explore` agents (read
excerpts), so absolute counts run low — but the *ratio* is the signal, same agent
type both sides. One task, one run.

---

## 3. Output tokens — making the edit

A downstream layer (`src/edit/`) lets the agent emit **structural ops against AST
anchors**, applied via ts-morph behind a type-check gate, instead of re-emitting
code.

### 3.1 Executed end-to-end — EXECUTED (`npm run bench:e2e`)

Same real change two ways, on a repo that compiles clean. Baseline edits are
*derived from the real reference sites*; protocol ops are *actually executed through
the gate* (both passed).

| same change | baseline (read + edit) | protocol (ops) | output | input |
|---|---|---|---|---|
| rename, 4 files / 16 sites | out 583, in 8,412 | out 16, in 131 | **−97%** | **−98%** |
| localized one-line edit | out 31, in 944 | out 45, in 150 | **+45% (worse)** | −84% |

**The honest read:** multi-site refactors win big on both ends (one directive, the
agent never reads the call sites). Localized single edits do **not** win on output —
the op's `OLD:`/`NEW:` header costs more than a bare `str_replace` on an
already-unique line; the value there is the input saving + the gate. **Output
savings are concentrated in fan-out refactors.**

### 3.2 Live-agent confirmation — LIVE-AGENT

Two real agents did the *same* rename (`tokenize` → `splitTokens` across codeindex),
one emitting protocol ops, one emitting str_replace edits. The str_replace baseline
is now **model-generated**, not authored.

| | output tokens |
|---|---|
| protocol (1 directive) | **16** |
| str_replace (8 edits the agent produced) | 312 |

**~19× fewer output tokens**, real-agent-generated on both sides — corroborating the
modeled e2e above (the agent deduped to 8 unique edits, so its baseline is lower than
the 16-reference-site count). Two honest notes:
- The str_replace agent also rewrote a **comment** mention of `tokenize`. The AST
  rename updates code references (declaration/imports/call-sites) but leaves comment
  text stale — symbol-rename vs text-rename. (Conversely str_replace risks renaming
  unrelated `tokenize` text.)
- This counts the **edit payloads**, not the agents' exploration/reasoning tokens
  (similar on both sides).

**Confirmed through the MCP tool (`apply_edits`).** Re-ran as a live A/B with the
edit layer exposed as an MCP server: two agents renamed `loadConfig` -> `readConfig`
across codeindex, one calling `list_anchors` + `apply_edits`, one with grep +
str_replace.

| | apply_edits (MCP) | grep + str_replace |
|---|---|---|
| emitted | one directive, 77 chars (~19 tok) | 12 edits, 1,130 chars (~283 tok) |
| files covered | 6 (gate-verified) | 6 |

**~15× fewer output tokens**, both reaching the same 6 files — so the win isn't from
doing less, and the MCP edit is type-checked before write (the manual edits aren't).
This is the strongest version: the agent literally called the tool; the gate ran
server-side.

### 3.3 Per-op detail — MODELED (`npm run bench:edit`, over codeindex's own source)

RENAME (one directive, regardless of site count):

| symbol | files | sites | whole-file re-emit | op | reduction |
|---|---|---|---|---|---|
| tokenize | 4 | 15 | 8,412 | 16 | 99.8% |
| loadConfig | 6 | 11 | 10,029 | 17 | 99.8% |
| **total (4 symbols)** | | | **25,968** | **69** | **99.7%** |

SET_BODY vs whole-file (86%) and vs a careful decl-only diff (15%). REPLACE_TEXT on
a small edit: 38 tok vs SET_BODY 81 vs a context-padded str_replace 51 — but note
3.1 Task 2: against an *already-unique* span the header makes it slightly worse.

### 3.4 Retry economics — EXECUTED (`npm run bench:retry`)

A big chunk op is the worst case: more surface area to get a type wrong, *and*
expensive to retry. A 25-line `SET_BODY` with a bogus `item.quantity` is caught by
the gate, then:

| recovery | retry tokens | total (attempt + retry) |
|---|---|---|
| full re-emit (whole body again) | 203 | 407 |
| scoped patch (one `REPLACE_TEXT`) | **32** | **236 (−42%)** |

**6× cheaper retry at 25 lines; ~40× at 200** — retry cost scales with the *fix*
under scoped repair, with the *chunk* under re-emit.

**Built:** `commit({ repair })` runs this automatically — keeps the rejected code in
a sandbox, attributes each new diagnostic to the op that caused it
(`AnchoredDiagnostic.nodeId`), and applies the patch ops without re-doing the passing
ops (`auto-repair: 1 round, anchored=true`). The `repair` callback is where a real
model plugs in; the benchmark uses a deterministic stand-in.

### 3.5 Net by operation (corrected)

| edit shape | net output tokens |
|---|---|
| rename / multi-site refactor | **large win** — O(N) edits → one directive |
| whole-node / signature rewrite | win — body vs str_replace's old+new |
| small in-body edit | **neutral-to-worse** — depends on uniqueness context (3.1) |
| brand-new code / additions | **neutral on a clean first try**, but wins under a retry (below) |

The input cost the protocol adds (nodeId anchors + spec) is small and
prompt-cacheable; the savings that exist are on the output side, which is priced
higher and latency-bound.

**The retry caveat (matters for additions).** The rows above are for a *clean
first attempt*. New code often fails the first type-check, and that flips it: the
big emission already happened once, the gate catches the error, and scoped repair
(§3.4) fixes only the bad span. So the retry costs ~the fix, not another whole
function. Versus a baseline that re-emits the chunk to fix it, the protocol wins
(the same 6× as §3.4); versus a baseline that already patches tightly, it's
roughly neutral — but it never lets broken new code land. So "additions don't
compensate" holds **only when there's no retry**.

---

## 4. A whole feature on an external repo — EXECUTED (`npm run bench:feature`)

To stress it beyond codeindex's own source, a full feature
(`countActiveBidsForRequest` + wiring) was added to an **unrelated real repo** (the
the test repo Drizzle/Elysia backend) entirely **in memory** (`write:false` — its working
tree is never touched):

1. `retrieve()` located the target file from a plain-English description.
2. `INSERT_BEFORE` (new function) + `REPLACE_TEXT` (wire it into the service) applied.
3. A **baseline-diff gate** (fail only on *newly introduced* diagnostics — the repo
   already had 25 pre-existing) confirmed the new code **type-checks against the
   repo's real types**.

**Honest finding:** on a *clean first try* the protocol emits *more* output than a
plain edit (115 vs 76 tok — you write the new code either way, plus op headers).
But that only holds with no retry: when the new code fails the type-check (common),
the gate catches it and scoped repair (§3.4) fixes just the bad span, so the retry
is a cheap patch instead of re-emitting the function. So for additions the value is
the **type-check gate plus a cheap retry**, not first-try token count.

---

## What's still modeled (not yet a live A/B)

Both **input (§2.2)** and **output (§3.2)** now have a live-agent A/B — the
str_replace and grep/read baselines are model-generated, not authored. Remaining:

- The output live A/B covers **refactors** (~19×). A live A/B for **small edits /
  additions** (where the protocol is neutral-to-worse, §3.1/§4) is not yet run.
- All A/Bs count **edit payloads / context read**, not full-session API `usage`
  (reasoning + tool scaffolding). Those are similar across both arms, but a true
  end-to-end token count would need the API `usage` field from two real sessions.
  → **Now provided** by the Agent A/B below (full-session `usage`, median of 3 real runs).
- Quality numbers (embedder, retrieval) come from small labeled sets — directional.

---

## Agent A/B — full-session, with vs without codeindex (LIVE-AGENT, API `usage`)

The end-to-end run the section above flagged as missing: full-session token counts straight from
**Claude Code's own `usage`** (reasoning + tool scaffolding included), not modeled edit payloads.
Same agent (Claude Code headless, **sonnet 4.6**), same tasks, with vs without codeindex's MCP
tools; an objective pass/fail `check` per task; clean git + index reset between runs. Run on this
repo (~600-symbol TS). **Median of 3 runs.** A third arm, **rust**, is the Rust rewrite
(`codeindex-rs`) for comparison. (Harness lives in the `codeindex-rs` repo: `scripts/agent-bench`,
which drives all three arms against a disposable clone.) `sec` = wall-clock for the whole run.

| task | arm | in_tok | out_tok | turns | sec | ok |
|---|---|--:|--:|--:|--:|:--:|
| T1-rename | baseline | 165658 | 940 | 8 | 23 | 3/3 |
|  | **ts** | **107015** | **604** | **4** | **19** | 3/3 |
|  | rust | 102264 | 563 | 4 | 15 | 3/3 |
| T2-move | baseline | 231593 | 1190 | 11 | 31 | 3/3 |
|  | **ts** | **76504** | **389** | **3** | **12** | 3/3 |
|  | rust | 75195 | 386 | 3 | 12 | 3/3 |
| T3-locate-edit | baseline | 100928 | 384 | 4 | 13 | 3/3 |
|  | ts | 130575 | 559 | 5 | 18 | 3/3 |
|  | rust | 127121 | 549 | 5 | 14 | 3/3 |

### Totals (median per task, summed)

| arm | input tok | output tok | sec | vs baseline (in / out / time) | success |
|---|--:|--:|--:|---|--:|
| baseline | 498179 | 2514 | 67 | — | 9/9 |
| **ts** | **314094** | **1552** | **49** | **−37% / −38% / −27%** | 9/9 |
| rust | 304580 | 1498 | 41 | −39% / −40% / −38% | 9/9 |

**Headlines:**
- **An agent with codeindex spends ~37% fewer tokens and ~27% less wall-clock**, all 9/9 — the
  whole-task effect, on top of the per-step savings modeled above.
- **The win is structural edits**: T2-move 3 turns vs baseline's 11; T1-rename 4 vs 8. The
  ts-morph type-check gate lets the agent do a cross-file rename/move in ONE call instead of
  grepping and hand-editing every site.
- **vs the Rust rewrite** (`codeindex-rs`): ~tied on tokens, the Rust port a bit faster on
  wall-clock (native core + a warm ts-morph gate). Same idea, different engine.

**Honest caveats:**
- **T3-locate is deliberately neutral** (a trivial one-liner): baseline is marginally leaner
  (4 turns vs 5) — the tool call adds a step when the find is easy. Keeping a task the tool does
  *not* win is what makes the average credible; the gain is in structural edits.
- **All 9/9 succeeded, so the gate's robustness value is NOT in these numbers** — a type-checked
  edit is insurance against broken edits, and insurance doesn't pay out on the happy path.
- 3 tasks, one single-package TS repo, sonnet 4.6, median of 3. The *shape* is robust; the
  absolute deltas are this-repo/these-tasks.
