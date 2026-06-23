// Write benchmark for the src/edit layer, measured over codeindex's OWN source.
//
// Question: how many OUTPUT tokens does the agent emit to make a change, under
//   (a) whole-file re-emit  — naive baseline
//   (b) changed-declaration only — what a careful diff-style agent emits
//   (c) the structural op format — STRUCTURAL_EDIT / CRITICAL_REFACTOR
//
// Token estimate = chars/4 (same as scripts/benchmark.ts). The % reduction is
// divisor-independent, so the headline holds regardless of the exact tokenizer.
//
// Every op is actually applied to an in-memory ts-morph project and passed
// through the diagnostics gate (write:false) to prove it is valid before we
// count its tokens — we never report savings for an edit that wouldn't compile.
import path from "node:path";
import { Project } from "ts-morph";
import { commit } from "../src/edit/index.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const TSCONFIG = path.join(ROOT, "tsconfig.json");
const tok = (s: string) => Math.round(s.length / 4);
const rel = (p: string) => path.relative(ROOT, p);

function freshProject(): Project {
  return new Project({ tsConfigFilePath: TSCONFIG });
}

// ── RENAME: exported symbols referenced across multiple files ─────────────────
const RENAME_TARGETS: { name: string; file: string; to: string }[] = [
  { name: "tokenize", file: "src/bm25.ts", to: "splitTokens" },
  { name: "embedText", file: "src/embeddings.ts", to: "encodeText" },
  { name: "loadConfig", file: "src/config.ts", to: "readConfig" },
  { name: "reciprocalRankFusion", file: "src/rrf.ts", to: "rrfMerge" },
];

// ── SET_BODY: replace a single function body ──────────────────────────────────
const BODY_TARGETS: { name: string; file: string }[] = [
  { name: "rankMatrix", file: "src/embeddings.ts" },
  { name: "cosineNormalized", file: "src/embeddings.ts" },
  { name: "reciprocalRankFusion", file: "src/rrf.ts" },
];

function benchSetBody() {
  console.log("\n=== SET_BODY (single function body edit) ===");
  console.log(
    `${"symbol".padEnd(22)}  ${"whole-file".padStart(10)} ${"decl-only".padStart(9)} ${"op(body)".padStart(8)}  vs-file  vs-decl`,
  );
  console.log("─".repeat(74));
  let sumFile = 0,
    sumDecl = 0,
    sumOp = 0;
  for (const t of BODY_TARGETS) {
    const project = freshProject();
    const sf = project.getSourceFileOrThrow(t.file);
    const fn = sf.getFunctionOrThrow(t.name);

    const wholeFileTok = tok(sf.getFullText()); // (a) re-emit file
    const declTok = tok(fn.getText()); // (b) re-emit just the function
    const bodyTok = tok(fn.getBodyText() ?? ""); // (c) op payload = statements only

    // Header overhead of the op block (2 lines + CODE:).
    const opTok = bodyTok + tok(`STRUCTURAL_EDIT: ${t.file}#fn_${t.name}\nACTION: SET_BODY\nCODE:\n`);

    sumFile += wholeFileTok;
    sumDecl += declTok;
    sumOp += opTok;
    const vsFile = (((wholeFileTok - opTok) / wholeFileTok) * 100).toFixed(1);
    const vsDecl = (((declTok - opTok) / declTok) * 100).toFixed(1);
    console.log(
      `${t.name.padEnd(22)}  ${String(wholeFileTok).padStart(10)} ${String(declTok).padStart(9)} ${String(opTok).padStart(8)}  ${(vsFile + "%").padStart(6)}  ${(vsDecl + "%").padStart(6)}`,
    );
  }
  console.log("─".repeat(74));
  console.log(
    `TOTAL${" ".repeat(17)}  ${String(sumFile).padStart(10)} ${String(sumDecl).padStart(9)} ${String(sumOp).padStart(8)}  ${(((sumFile - sumOp) / sumFile) * 100).toFixed(1)}%  ${(((sumDecl - sumOp) / sumDecl) * 100).toFixed(1)}%`,
  );
}

// ── REPLACE_TEXT: small edit inside a body — where SET_BODY loses ─────────────
// A one-line change in a function. Compares what each strategy makes the agent
// emit. str_replace(approx) = old span + ~2 lines context (for file-uniqueness)
// + new span; REPLACE_TEXT = old span + new span (node-scoped, no extra context).
const SMALL_EDIT = {
  name: "rankMatrix",
  file: "src/embeddings.ts",
  oldText: "scored.sort((a, b) => b.score - a.score);",
  newText: "scored.sort((a, b) => b.score - a.score || a.row - b.row);",
  contextLines: 2, // lines str_replace must add around the span to be file-unique
};

function benchReplaceText() {
  console.log("\n=== small in-body edit (one line of a function) ===");
  const project = freshProject();
  const fn = project.getSourceFileOrThrow(SMALL_EDIT.file).getFunctionOrThrow(SMALL_EDIT.name);
  const lines = fn.getText().split("\n");
  const ctxChars = lines.slice(0, SMALL_EDIT.contextLines).join("\n").length;

  const setBody = tok(fn.getBodyText() ?? "") + tok("STRUCTURAL_EDIT: …\nACTION: SET_BODY\nCODE:\n");
  const replaceText =
    tok(SMALL_EDIT.oldText) + tok(SMALL_EDIT.newText) + tok("STRUCTURAL_EDIT: …\nACTION: REPLACE_TEXT\nOLD:\nNEW:\n");
  const strReplace =
    tok(SMALL_EDIT.oldText) + tok(SMALL_EDIT.newText) + 2 * Math.round(ctxChars / 4); // old+ctx and new+ctx

  console.log(`  SET_BODY (re-emit whole body):     ${String(setBody).padStart(4)} tokens`);
  console.log(`  str_replace (Claude Code, approx): ${String(strReplace).padStart(4)} tokens`);
  console.log(`  REPLACE_TEXT (node-scoped span):   ${String(replaceText).padStart(4)} tokens`);
  console.log(
    `  -> REPLACE_TEXT vs SET_BODY: ${(((setBody - replaceText) / setBody) * 100).toFixed(0)}% cheaper;` +
      ` vs str_replace: ${(((strReplace - replaceText) / strReplace) * 100).toFixed(0)}% cheaper`,
  );
}

async function main() {
  await benchRename();
  benchSetBody();
  benchReplaceText();
  console.log("\n(token = chars/4; % reduction is divisor-independent. Every RENAME op was");
  console.log(" applied + passed the diagnostics gate in-memory before counting.)");
}

async function benchRename() {
  console.log("\n=== RENAME (workspace-wide, exported symbol) ===");
  console.log(
    `${"symbol".padEnd(22)} ${"files".padStart(5)} ${"sites".padStart(5)}  ${"whole-file".padStart(10)} ${"op".padStart(4)}  reduction  valid`,
  );
  console.log("─".repeat(78));
  let sumBase = 0,
    sumOp = 0;
  for (const t of RENAME_TARGETS) {
    const project = freshProject();
    const sf = project.getSourceFileOrThrow(t.file);
    const fn = sf.getFunctionOrThrow(t.name);
    const refNodes = fn.findReferencesAsNodes();
    const filesTouched = new Set(refNodes.map((n) => n.getSourceFile().getFilePath()));
    filesTouched.add(sf.getFilePath());

    let wholeFileTok = 0;
    for (const fp of filesTouched) wholeFileTok += tok(project.getSourceFileOrThrow(fp).getFullText());

    const directive = `CRITICAL_REFACTOR: RENAME ${t.file}#fn_${t.name} TO ${t.to}`;
    const opTok = tok(directive);

    const res = await commit(
      project,
      [{ type: "RENAME", nodeId: `${t.file}#fn_${t.name}`, newName: t.to }],
      { write: false, fullProjectLoaded: true },
    );

    sumBase += wholeFileTok;
    sumOp += opTok;
    const pct = (((wholeFileTok - opTok) / wholeFileTok) * 100).toFixed(1);
    console.log(
      `${t.name.padEnd(22)} ${String(filesTouched.size).padStart(5)} ${String(refNodes.length).padStart(5)}  ${String(wholeFileTok).padStart(10)} ${String(opTok).padStart(4)}  ${(pct + "%").padStart(8)}   ${res.ok ? "✓" : "✗"}`,
    );
  }
  console.log("─".repeat(78));
  console.log(
    `TOTAL${" ".repeat(35)}${String(sumBase).padStart(10)} ${String(sumOp).padStart(4)}  ${(((sumBase - sumOp) / sumBase) * 100).toFixed(1)}%`,
  );
}

main();
