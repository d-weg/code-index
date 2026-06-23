# AST-Anchored Edit Operations — Design & Findings

> 🇧🇷 Documento de design em inglês. Visão geral em português:
> [../README.pt-BR.md](../README.pt-BR.md) · resultados: [../RESULTS.pt-BR.md](../RESULTS.pt-BR.md).

Status: prototype complete and verified end-to-end (`npm run demo`, `npm run bench`,
`npm run typecheck` all green). This document is the durable record of the
architecture, the protocol, every claim we verified empirically, and the
decisions behind them.

---

## 1. Problem & goal

Reduce **output tokens** and improve **structural reliability** of agent code
edits, without touching the retrieval pipeline (Model2Vec `potion-code-16M` +
BM25). Instead of the agent emitting whole files or fuzzy search-and-replace, it
emits explicit structural operations against absolute AST node identifiers,
which the runner executes with `ts-morph` and gates on the TypeScript compiler.

What we deliberately **rejected** from the original proposal: identifier aliasing
(`enterpriseUserAuthenticationPayload` → `_a`) and a per-session `tokenMap`. It
costs more input tokens than it saves on output, degrades model reasoning (names
are the model's scaffold), and adds round-trip corruption risk. The token win
comes from *not re-emitting whole files*, not from shortening identifiers.

---

## 2. System architecture

```
[User query]
     │
     ▼
[Hybrid search: Model2Vec potion-code-16M + BM25]   ← UNCHANGED, canonical raw code
     │  top-k chunks
     ▼
[Manifest assembler]
     • indexSourceFile(): decorate retrieved nodes with deterministic nodeIds
     • deliver raw, human-readable source + nodeId anchors
     ▼
[LLM agent]  emits structural ops (never whole files):
     • STRUCTURAL_EDIT … ACTION: SET_BODY | REPLACE_NODE
     • CRITICAL_REFACTOR: RENAME … TO …
     ▼
[Runtime runner — FULL ts-morph Project loaded from tsconfig]
     • parseOps() → AgentOp[]
     • apply on live AST
     • project.getPreEmitDiagnostics()  ← whole-project type-check gate
     • clean → project.save()   |   fail → roll back all files, return feedback
```

The retrieval layer and the mutation layer are decoupled: search runs on raw
chunks for embedding/lexical accuracy; mutation runs on the full resolved module
graph because diagnostics and rename are meaningless on isolated chunks.

---

## 3. nodeId grammar  (`src/nodeId.ts`)

```
relativePath#<prefix>_<name>[~index]
```

| prefix | kind | name form |
|--------|------|-----------|
| `fn_`    | FunctionDeclaration  | `fn_registerUser` |
| `cls_`   | ClassDeclaration     | `cls_UserService` |
| `iface_` | InterfaceDeclaration | `iface_RegisterPayload` |
| `enum_`  | EnumDeclaration      | `enum_Role` |
| `type_`  | TypeAliasDeclaration | `type_UserId` |
| `var_`   | VariableDeclaration  | `var_config` |
| `meth_`  | MethodDeclaration    | `meth_UserService.create` |

- `~index` disambiguates same-name / same-kind nodes (overloads, nested scopes).
- **One grammar, two directions:** `indexSourceFile()` generates ids at manifest
  time; `parseNodeId()` + `RefactorRunner.resolve()` map them back. They share the
  prefix table, so ids can't drift between generation and resolution.
- Resolution **fails closed** (`AnchorError`) on no match or unresolved ambiguity —
  never guesses.

---

## 4. Wire protocol  (`src/protocol.ts`)

```
STRUCTURAL_EDIT: src/auth/service.ts#fn_registerUser
ACTION: SET_BODY            # statements only — signature preserved
CODE:
const hashed = await this.crypto.hash(payload.password);
return this.db.users.create({ ...payload, password: hashed });

STRUCTURAL_EDIT: src/auth/service.ts#fn_registerUser
ACTION: REPLACE_NODE        # whole declaration — use when the signature changes
CODE:
async function registerUser(p: RegisterPayload, opts: Opts): Promise<User> { ... }

CRITICAL_REFACTOR: RENAME src/auth/service.ts#fn_registerUser TO executeUserRegistration
```

**Parser design — fastest option chosen:** a single linear pass over lines. No
regex backtracking, no per-block rescanning. The two top-level keywords are
boundary markers that terminate a `CODE:` payload; `ACTION:`/`CODE:` are
sub-headers inside an edit block. Verified tolerant of: trailing whitespace on
headers, lowercase actions (`set_body`), blank lines between sub-headers,
conversational prose around blocks, and exact preservation of code indentation.

**Edit actions** (pick by edit shape — keeps each op at its cheapest):
- `SET_BODY` → `node.setBodyText(stmts)` — whole-body rewrite; signature preserved.
- `REPLACE_NODE` → `node.replaceWithText(decl)` — when the signature changes.
- `REPLACE_TEXT` → anchored str_replace via `OLD:`/`NEW:` spans, for small
  localized edits. `oldText` must be unique *within the node* (fail-closed
  otherwise), so it needs no file-global context — ~25% cheaper than a plain
  str_replace and avoids SET_BODY's whole-body re-emit. Wire form:

  ```
  STRUCTURAL_EDIT: src/foo.ts#fn_bar
  ACTION: REPLACE_TEXT
  OLD:
  <old span>
  NEW:
  <new span>
  ```

**File-level ops** (repo-relative paths; need `rootDir` to resolve):
- `MOVE_FILE: <from> TO <to>` → `sourceFile.move()` — moves the file AND rewrites
  every import specifier that references it, repo-wide. The file analog of RENAME:
  one directive vs editing N importers. Measured **18× fewer output tokens** moving
  a file imported by 8 (one line vs 8 str_replace edits), and it grows with importer
  count (`npm run bench:movefile`).
- `DELETE_FILE: <path>` → `sourceFile.delete()` — the gate rejects if anything still
  imports it.
- `CREATE_FILE: <path>` + `CODE:` → `project.createSourceFile()` — gate-verified;
  like other additions, neutral on tokens, value is the type-check.

> **Caveat — module-specifier style.** `MOVE_FILE` rewrites specifiers using the
> project's style, derived from `moduleResolution`. Under `bundler` it *drops* the
> `.js` extension (`"./a.js"` → `"./a"`) — correct for bundler/tsx runtimes, but if
> you run strict Node ESM with bundler resolution, verify the result. Use
> `NodeNext`/`Node16` resolution and ts-morph preserves the extension.

---

## 5. Execution lifecycle  (`src/runner.ts`)

`commit(project, ops, { write, fullProjectLoaded })`:

1. **Snapshot** every source file's text into a `Map` (rollback boundary).
2. **Apply** each op on the live Project:
   - `SET_BODY` → `setBodyText`
   - `REPLACE_NODE` → `replaceWithText`
   - `RENAME` → guards → `rename` (language-service, workspace-wide)
   On any op error: roll back, return `{ ok:false, failedOpIndex, feedback }`.
3. **Diagnostics gate:** `project.getPreEmitDiagnostics()`. Non-empty → roll back
   all files, return formatted diagnostics (feed straight back to the agent).
4. **Commit:** only on a clean gate → `project.save()`.

Atomic and all-or-nothing. Type errors never reach disk.

---

## 6. Guards

| Guard | Where | Rule |
|-------|-------|------|
| **Full-project** | `applyRename` | RENAME throws unless `fullProjectLoaded: true`. Partial load makes rename silently miss call-sites (verified §7). |
| **Provenance** | `isProjectOwned` | Only mutate symbols whose *every* declaration is inside the source tree — never `node_modules`/`.d.ts`. Subsumes keyword/global/library blocklists; blocks renaming `Promise`, `Error`, library types. |
| **Collision** | `collides` | Reject a rename target already visible in scope (uses the type checker's scope view, respects shadowing). |

The diagnostics gate is the catch-all *type* check; the guards prevent specific
*semantic* foot-guns the type check can't see before they happen.

---

## 7. Verified findings (empirical, not asserted)

| # | Claim | Result |
|---|-------|--------|
| 1 | `SET_BODY` swaps body, preserves signature | ✅ |
| 2 | `RENAME` updates call-sites + imports across files | ✅ when full project loaded |
| 3 | **Lazy/partial project → `rename()` silently misses unloaded call-sites** | ⚠️ confirmed — declaration became `executeUserRegistration` while the caller in an unloaded file kept calling `registerUser`. Compiles in the loaded subset, breaks on disk. This is why the full-project guard is mandatory. |
| 4 | Bad edit (TS2322) caught by gate → all files rolled back cleanly | ✅ |
| 5 | Parser survives malformed whitespace / noise | ✅ |
| 6 | **Rename propagates through barrel re-exports** | ✅ |
| 7 | **Rename through aliased re-export** (`registerUser as createAccount`) renames the original side, leaves the public alias intact | ✅ — correct symbol semantics; the alias is a separate name. |
| 8 | Output-token cost vs full-file re-emit (3-file rename) | **~88% reduction** (264→31 est.); grows with call-site count since the wire payload stays one line. |

### Rename blind spots (language-service limits — document for users)
`rename()` is the TS language service; it only sees statically resolvable refs.
It will **not** catch: string-based references (`"registerUser"`, DI tokens,
dynamic property access), files outside the `tsconfig` graph (other monorepo
packages not included, generated code, configs), or non-TS usages (templates,
route strings, docs). The diagnostics gate catches resulting *type* breakage but
not a stale string literal that still compiles. Pair renames with a plain grep
for the old name as a post-check.

---

## 8. Embedding layer — decision: SWAP to a static model is beneficial

> Corrected after verifying the actual `codeindex` repo. An earlier draft of this
> section trusted the spec doc's claim that the stack already used Model2Vec
> `potion-code-16M`. The code contradicts it.

**Verified reality (`the codeindex repo`):**

| | Spec doc claimed | Actual code |
|---|---|---|
| Embedder | Model2Vec `potion-code-16M` (static) | `Xenova/bge-small-en-v1.5` (real ~33M transformer, ONNX) |
| Encoder at query time | none | **yes — forward pass per query** |
| Lexical | BM25 | ✅ `src/bm25.ts` |
| Fusion | — | ✅ RRF, `src/rrf.ts`, `rrfK: 60` |

- `codeindex.config.json` → `"embeddingModel": "Xenova/bge-small-en-v1.5"`.
- `package.json` depends on `@xenova/transformers`, not `model2vec`.
- `src/embeddings.ts:20` calls `tf.pipeline("feature-extraction", model)`;
  `embedText()` runs a full transformer forward pass, including at query time.

"Sembler" = **Semble** (MinishLab/semble), whose model is the static Model2Vec
`potion-code-16M`. Because the repo is currently on the **transformer** side, the
swap is a real win, not a no-op:

- **Speed:** removes the per-query forward pass → the ~10x faster query / ~200x
  faster index Semble measures against exactly this kind of model.
- **Quality:** `bge-small-en-v1.5` is **general English**; `potion-code-16M` is
  **code-specialized** → likely equal-or-better code retrieval *and* the speed win.
- **Low blast radius:** the embedder is isolated behind `embedText`/`embedBatch`/
  `rankMatrix` in `src/embeddings.ts`. Swap the `@xenova` pipeline for a Model2Vec
  static lookup and re-index; BM25, RRF, and the store are untouched.

**Conclusion: beneficial — do the swap, gated by the existing `eval`/`benchmark`
scripts** (general-vs-code-specialized can surprise on a specific codebase;
confirm NDCG before committing). The genuine output-token cost center is still
addressed separately by the protocol above.

---

## 9. Integration steps (against the CodeIndex / Semble pipeline)

1. **Manifest assembler:** after top-k retrieval, for each matched file run
   `indexSourceFile(sourceFile, relPath)` and emit the raw chunk text decorated
   with the resulting `nodeId`s. Retrieval scoring is untouched.
2. **Runner bootstrap:** load the full project once from the workspace
   `tsconfig.json` (`new Project({ tsConfigFilePath })`, no `skipAddingFiles`).
   Keep it warm/persistent; do **not** lazy-load per request if RENAME is allowed.
3. **Agent contract:** instruct the agent to emit only `STRUCTURAL_EDIT` /
   `CRITICAL_REFACTOR` blocks; default body edits to `SET_BODY`.
4. **Apply loop:** `parseOps(agentOutput)` → `commit(project, ops, { fullProjectLoaded: true })`.
   On `{ ok:false }`, return `feedback` to the agent for a repair turn.
5. **Post-commit:** run `sourceFile.formatText()` / prettier (setBodyText preserves
   the indentation passed in), and grep the old name after any RENAME.

---

## 10. Open items / next steps

- [ ] Wire `indexSourceFile` into a real decorated-source emitter for the manifest.
- [ ] Add post-rename grep check (old name → flag surviving non-TS/string refs) as
      a soft warning on the success path.
- [ ] Replace the heuristic `estimateTokens` with the real tokenizer for billing-
      accurate deltas.
- [ ] Persist/warm the ts-morph Project across requests; measure full-load time on
      the target repo (it is the main latency cost of RENAME).
- [ ] Extend nodeId structural-path component for deeply nested / duplicated names
      if `~index` proves insufficient on the real codebase.

---

## Sources
- Semble — https://github.com/MinishLab/semble
- Model2Vec (static embeddings) — https://github.com/MinishLab/model2vec
- ts-morph — https://ts-morph.com
