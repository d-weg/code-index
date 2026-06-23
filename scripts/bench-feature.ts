// Full feature, end-to-end, on a REAL external repo (the test repo) — in memory only
// (write:false), so the test repo's working tree is never touched.
//
// Feature: add `countActiveBidsForRequest` to the bids service and expose it.
// Flow: retrieve() finds where it goes → protocol ops add it → baseline-diff gate
// proves the new code type-checks against the test repo's real types → measure tokens.
import path from "node:path";
import { promises as fs } from "node:fs";
import { Project } from "ts-morph";
import { commit, parseOps } from "../src/edit/index.js";
import { retrieve } from "../src/retrieve.js";

// Point BENCH_REPO at a TypeScript backend repo (with apps/backend/tsconfig.json).
// This was run against a private test repo; it won't reproduce without one.
const REPO = process.env.BENCH_REPO ?? "";
if (!REPO) throw new Error("set BENCH_REPO to a TS backend repo path");
const BACKEND_TSCONFIG = path.join(REPO, "apps/backend/tsconfig.json");
const SVC = "src/features/bids/bids.service.ts";
const tok = (s: string) => Math.round(s.length / 4);

const NEW_FN = `const countActiveBidsForRequest = async (requestId: string) => {
  const rows = await db
    .select()
    .from(bids)
    .where(and(eq(bids.requestId, requestId), ne(bids.status, "rejected")));
  return rows.length;
};`;

// The protocol payload the agent emits (two ops): add the function, wire it in.
const OPS_WIRE = `STRUCTURAL_EDIT: ${SVC}#var_service
ACTION: INSERT_BEFORE
CODE:
${NEW_FN}

STRUCTURAL_EDIT: ${SVC}#var_service
ACTION: REPLACE_TEXT
OLD:
  decideBid,
NEW:
  decideBid,
  countActiveBidsForRequest,`;

async function main() {
  // 1. Retrieval: does the index point the agent at the right file?
  console.log("=== 1. retrieve() — where does this feature go? ===");
  const manifest = await retrieve(REPO, "count a request's active non-rejected bids in the bids service");
  const top = manifest.entries.slice(0, 5).map((e) => `${e.reason.padEnd(16)} ${e.file}`);
  console.log(top.join("\n"));
  const found = manifest.entries.some((e) => e.file.endsWith(SVC));
  console.log(`bids.service.ts in manifest: ${found ? "✓" : "✗"}`);

  // 2. Load the test repo backend, apply the feature ops, baseline-diff gate, no disk write.
  console.log("\n=== 2. apply feature via protocol (in-memory, write:false) ===");
  const project = new Project({ tsConfigFilePath: BACKEND_TSCONFIG });
  const ops = parseOps(OPS_WIRE);
  console.log(`parsed ${ops.length} ops: ${ops.map((o) => o.type).join(", ")}`);

  const res = await commit(project, ops, { write: false, baselineDiff: true });
  console.log(`gate (only NEW diagnostics fail): ${res.ok ? "PASS ✓" : "FAIL ✗"}`);
  if (!res.ok) {
    console.log(res.feedback.split("\n").slice(0, 6).join("\n"));
    process.exit(1);
  }

  // 3. Show the feature actually landed (in memory).
  console.log("\n=== 3. result (in-memory bids.service.ts) ===");
  const sf = project.getSourceFiles().find((f) => f.getFilePath().endsWith(SVC))!;
  const text = sf.getFullText();
  const fnLine = text.split("\n").findIndex((l) => l.includes("countActiveBidsForRequest = async"));
  console.log(text.split("\n").slice(fnLine, fnLine + 7).join("\n"));
  console.log("  …");
  const svcStart = text.split("\n").findIndex((l) => l.startsWith("const service = {"));
  console.log(text.split("\n").slice(svcStart, svcStart + 11).join("\n"));

  // 4. Token note (honest: additions don't save OUTPUT — you emit the code either way).
  console.log("\n=== 4. tokens (honest) ===");
  const fileFull = await fs.readFile(path.join(REPO, "apps/backend", SVC), "utf8");
  const baselineOut = tok(NEW_FN) + tok("  decideBid,\n}") + tok("  decideBid,\n  countActiveBidsForRequest,\n}") + 6;
  const protocolOut = tok(OPS_WIRE);
  console.log(`  input  — baseline reads whole file: ${tok(fileFull)} tok   |  protocol reads manifest ranges (retrieval saves here)`);
  console.log(`  output — baseline edits: ~${baselineOut} tok   |  protocol ops: ${protocolOut} tok`);
  console.log("  → for an ADD, output is ~equal (you emit the new code either way).");
  console.log("    The protocol's value here is the type-check gate, not token savings.");
  console.log("    Output savings come from REFACTORS (rename), not additions.");

  console.log("\n" + "─".repeat(70));
  console.log(`the test repo disk untouched (write:false). Feature verified against ${project.getSourceFiles().length} real backend files.`);
}

main();
