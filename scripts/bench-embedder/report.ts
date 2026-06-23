// Merge results_bge.json + results_potion.json into a comparison table.
// Metric: rank of the case's expected file in the dense file ranking (0 = top).
// PASS = rank within seed budget (topN = 8). Reports pass@8 and MRR per model.
import { promises as fs } from "node:fs";
import path from "node:path";

const DATA = path.join(import.meta.dirname, ".data");
const SEED_N = 8;

interface Res {
  model: string;
  dims: number;
  embedMs: number;
  queryMsAvg: number;
  results: { task: string; layer: string; rank: number }[];
}

const rr = (rank: number) => (rank >= 0 ? 1 / (rank + 1) : 0);
const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));

async function main() {
  const bge: Res = JSON.parse(await fs.readFile(path.join(DATA, "results_bge.json"), "utf8"));
  const pot: Res = JSON.parse(await fs.readFile(path.join(DATA, "results_potion.json"), "utf8"));

  console.log(`\nEMBEDDER COMPARISON  (dense-only retrieval, same chunk texts, ${bge.results.length} cases)`);
  console.log(`A = ${bge.model} (${bge.dims}d)   B = ${pot.model} (${pot.dims}d)`);
  console.log("rank = position of expected file in dense file ranking (0 = top, -1 = miss)\n");

  console.log(`${pad("task", 50)} ${pad("layer", 8)}  A.rank  B.rank  winner`);
  console.log("─".repeat(86));
  let aPass = 0, bPass = 0, aMrr = 0, bMrr = 0;
  for (let i = 0; i < bge.results.length; i++) {
    const a = bge.results[i], b = pot.results[i];
    const aOk = a.rank >= 0 && a.rank < SEED_N, bOk = b.rank >= 0 && b.rank < SEED_N;
    aPass += aOk ? 1 : 0; bPass += bOk ? 1 : 0;
    aMrr += rr(a.rank); bMrr += rr(b.rank);
    const win = a.rank === b.rank ? "=" : (b.rank >= 0 && (a.rank < 0 || b.rank < a.rank)) ? "B" : "A";
    const fmt = (r: number) => (r < 0 ? "  miss" : String(r).padStart(6));
    console.log(`${pad(a.task, 50)} ${pad(a.layer, 8)}  ${fmt(a.rank)}  ${fmt(b.rank)}    ${win}`);
  }
  console.log("─".repeat(86));
  const n = bge.results.length;
  console.log(`pass@${SEED_N}:   A ${aPass}/${n}    B ${bPass}/${n}`);
  console.log(`MRR:      A ${(aMrr / n).toFixed(3)}    B ${(bMrr / n).toFixed(3)}`);
  console.log(`\nspeed (CPU, ${bge.results.length} cases / ${"chunks"}):`);
  console.log(`  query embed avg:    A ${bge.queryMsAvg.toFixed(1)}ms    B ${pot.queryMsAvg.toFixed(2)}ms`);
  console.log(`  full chunk-embed:   A ${bge.embedMs}ms    B ${pot.embedMs}ms  (A is ${(bge.embedMs / pot.embedMs).toFixed(1)}x slower)`);
}

main();
