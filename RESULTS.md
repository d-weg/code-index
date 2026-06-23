# Results — token savings

`codeindex` cuts the tokens an agent spends on a code task in two places: the
**input** it reads to find context, and the **output** it emits to make the change.
Every number below is from real runs on a real repo (`the test repo`). Token = chars/4;
the **% reduction is divisor-independent**, so it holds under any tokenizer.

Two baselines are shown throughout, on purpose — a conservative floor and a
realistic one — so nothing is cherry-picked.

---

## Input tokens — finding the context

Instead of the agent reading whole files (or grepping and reading every hit),
`codeindex` returns a manifest of the relevant files **with line-ranges**. Real
runs, 3 real tasks:

| task | WITH index | vs reading right files whole | vs grep-and-read-all |
|---|---|---|---|
| accept a bid (atomic sibling reject) | 13,410 | 17,796 → **25% saved** | 73,021 → **82% saved** |
| deduct a credit on unlock | 9,096 | 15,660 → **42% saved** | 57,303 → **84% saved** |
| presign R2 + blurred CDN copy | 9,493 | 12,740 → **25% saved** | 21,008 → **55% saved** |

- **Conservative floor (25–42%):** assumes the agent already *knows* the exact
  files and reads them whole — `codeindex` only adds line-range narrowing. This
  undersells (graph-expanded files have no ranges, so they're whole in both).
- **Realistic (55–84%):** what an agent actually burns finding context — keyword
  grep, then read every hit whole. The manifest's own cost (~1.1k tokens) is
  included in the WITH column.

```bash
npm run benchmark -- ~/the test repo "deduct a credit atomically when a shop unlocks a repair lead"
```

---

## Output tokens — making the edit

A downstream layer (`src/edit/`) lets a coding agent emit **structural ops against
AST anchors**, applied via ts-morph behind a type-check gate, instead of
re-emitting code. Measured **end-to-end on a real repo** (codeindex itself): the
baseline edits are derived from the real reference sites, and the protocol ops are
**actually executed through the diagnostics gate** (both tasks passed).

| same change, two ways | baseline (read + edit) | protocol (AST ops) | output | input |
|---|---|---|---|---|
| rename across 4 files / 16 sites | out 583, in 8,412 | out 16, in 131 | **−97%** | **−98%** |
| localized one-line edit | out 31, in 944 | out 45, in 150 | **+45% (worse)** | −84% |

**The honest read:**
- **Multi-site refactors win big, both ends.** The agent emits one directive and
  never reads the call sites — the runner rewrites all 16, gated by the type-checker.
- **Localized single edits do *not* win on output.** The op's `OLD:`/`NEW:` header
  costs more than a bare `str_replace` on an already-unique line. The value there is
  the input saving (read the node, not the file) and the safety gate — not output.
  For one-off edits, a plain diff is the right tool.

So the output-token win is **concentrated in fan-out refactors**, not every edit.

```bash
npm run bench:e2e    # this table (executed end-to-end)
npm run test:edit    # correctness + rollback
```

### Whole feature, on a real external repo

To stress it beyond codeindex's own source, a full feature was added to an
**unrelated real repo** (a Drizzle/Elysia backend) entirely **in memory**
(`write:false`, so its working tree is never touched):

1. `retrieve()` located the target file from a plain-English feature description.
2. Two ops — `INSERT_BEFORE` (new function) + `REPLACE_TEXT` (wire it into the
   exported service) — were applied.
3. A **baseline-diff gate** (fail only on *newly introduced* diagnostics — the
   repo already had 25 pre-existing) confirmed the new code **type-checks against
   the repo's real types**.

Honest finding: for an **addition**, the protocol emits *more* output than a plain
edit (you write the new code either way, plus op headers). The value for additions
is the **type-check gate**, not tokens — output savings are a refactor phenomenon.

```bash
npm run bench:feature
```

---

## How to read these honestly

- Input and output are **separate phases** — they're not summed into one headline.
- The **conservative floor** numbers are unattackable; the **realistic** numbers
  carry the stated "grep-and-read-all" assumption, which can over- or under-state
  for a specific agent.
- The retrieval quality of the underlying index is validated separately
  (`npm run eval`, labeled cases).

*Stack: pure Node + TypeScript, zero API calls on the query path, no external
vector DB. The embedder also has a Node-native Model2Vec backend (no Python) —
a speed/footprint detail, documented in [docs/benchmarks.md](docs/benchmarks.md),
not part of this token story.*
