#!/usr/bin/env -S npx tsx
// One-prompt benchmark: context-gathering cost WITH retrieve_context vs WITHOUT.
//
// WITHOUT  = the agent reads the relevant files in FULL (the naive baseline — and a
//            conservative one: it ignores the extra grep/read round-trips and wrong-file
//            reads an agent does to *find* those files, which only makes the real gap wider).
// WITH     = the manifest JSON + only the line-ranges the manifest targets.
//
// Token estimate uses chars/4 (labeled). The % reduction is divisor-independent — it's the
// same whether measured in chars, chars/4, or real count_tokens output — so the headline
// number is robust; only the absolute token figure is an estimate.

import { promises as fs } from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import { retrieve } from "../src/retrieve.js";
import { loadConfig } from "../src/config.js";

const root = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
const TASK =
  process.argv.slice(3).join(" ") ||
  "merge bm25, vector, and symbol-name search results with reciprocal rank fusion and expand along the import graph";

const estTokens = (chars: number) => Math.round(chars / 4);

async function readFileSafe(p: string): Promise<string> {
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return "";
  }
}

function sliceRanges(content: string, ranges: [number, number][]): string {
  const lines = content.split("\n");
  const keep = new Set<number>();
  for (const [a, b] of ranges) for (let i = a; i <= b; i++) keep.add(i);
  return [...keep]
    .sort((x, y) => x - y)
    .map((ln) => lines[ln - 1])
    .filter((l) => l !== undefined)
    .join("\n");
}

const STOP = new Set(["the", "and", "for", "with", "that", "this", "when", "into", "from", "atomically"]);
function keywords(task: string): string[] {
  return [...new Set(task.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !STOP.has(w)))];
}

/** Realistic "no index" baseline: grep the repo for the task's keywords, read every hit whole. */
async function naiveGrepBaseline(repo: string, kws: string[]): Promise<{ files: number; chars: number }> {
  const config = await loadConfig(repo);
  const paths = await fg(config.include, { cwd: repo, ignore: config.exclude, onlyFiles: true });
  let chars = 0;
  let files = 0;
  for (const rel of paths) {
    const content = await readFileSafe(path.resolve(repo, rel));
    const lc = content.toLowerCase();
    if (kws.some((k) => lc.includes(k))) {
      chars += content.length;
      files++;
    }
  }
  return { files, chars };
}

async function main() {
  console.log(`\nTASK: "${TASK}"`);
  console.log(`REPO: ${root}\n`);

  const manifest = await retrieve(root, TASK);

  let wholeChars = 0;
  let targetedChars = 0;
  const rows: { file: string; reason: string; whole: number; targeted: number }[] = [];

  for (const e of manifest.entries) {
    const content = await readFileSafe(path.resolve(root, e.file));
    const whole = content.length;
    const targetedText =
      e.wholeFile || e.matchedSymbols.length === 0
        ? content
        : sliceRanges(content, e.matchedSymbols.map((m) => m.lineRange));
    const targeted = targetedText.length;
    wholeChars += whole;
    targetedChars += targeted;
    rows.push({ file: e.file, reason: e.reason, whole: estTokens(whole), targeted: estTokens(targeted) });
  }

  const manifestChars = JSON.stringify(manifest).length;
  const withoutChars = wholeChars;
  const withChars = manifestChars + targetedChars;
  const reduction = withoutChars > 0 ? (1 - withChars / withoutChars) * 100 : 0;

  // Per-file table.
  console.log("per-file (est. tokens):");
  console.log(`  ${"reason".padEnd(17)}${"whole".padStart(7)}${"targeted".padStart(10)}   file`);
  for (const r of rows) {
    console.log(`  ${r.reason.padEnd(17)}${String(r.whole).padStart(7)}${String(r.targeted).padStart(10)}   ${r.file}`);
  }

  const kws = keywords(TASK);
  const naive = await naiveGrepBaseline(root, kws);
  const naiveReduction = naive.chars > 0 ? (1 - withChars / naive.chars) * 100 : 0;

  console.log("\n────────────────────────────────────────────");
  console.log(`manifest:  ${manifest.entries.length} files  (~${estTokens(manifestChars)} tok JSON)`);
  console.log("");
  console.log(`WITH index (manifest + ranges):              ~${estTokens(withChars)} tok`);
  console.log("");
  console.log("(a) narrowing only — manifest files read whole as baseline:");
  console.log(`    WITHOUT: ~${estTokens(withoutChars)} tok   →  ${reduction.toFixed(1)}% saved`);
  console.log("");
  console.log(`(b) realistic — naive keyword grep [${kws.join(", ")}] then read every hit whole:`);
  console.log(`    WITHOUT: ~${estTokens(naive.chars)} tok across ${naive.files} files  →  ${naiveReduction.toFixed(1)}% saved`);
  console.log("────────────────────────────────────────────");
  console.log("\n(a) counts only range-narrowing on the focused set (undersells — graph-expanded");
  console.log("    files have no ranges, so they're whole in both columns).");
  console.log("(b) is the real comparison: what an agent burns finding context without the index.\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
