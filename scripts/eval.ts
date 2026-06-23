#!/usr/bin/env -S npx tsx
// Labeled ranking eval — measures package-aware ranking changes instead of eyeballing.
//
// For each labeled task we run retrieve() and check whether the expected backend/mobile
// implementation file lands in the SEEDS (the top-N fused files, before graph expansion),
// and at what rank in the full manifest. A task PASSES when any of its `expect` files is a
// seed. Backend tasks should pass *without* regressing the mobile control tasks.
//
// Usage:
//   BENCH_REPO=/path/to/repo npx tsx scripts/eval.ts   # or pass [repoRoot]
//   CODEINDEX_NO_PKG_WEIGHT=1 npx tsx ...      # baseline (weighting disabled) for comparison

import path from "node:path";
import { retrieve } from "../src/retrieve.js";
import { loadConfig } from "../src/config.js";

interface EvalCase {
  layer: "backend" | "mobile";
  task: string;
  /** Any one of these files landing in the seeds = pass. First is the canonical target. */
  expect: string[];
}

// Four backend-logic tasks (the ones the benchmark leaned mobile-heavy on) + two
// mobile control tasks that must NOT regress.
const CASES: EvalCase[] = [
  {
    layer: "backend",
    task: "accept a bid: reject the sibling bids and flip the repair request status atomically",
    expect: ["apps/backend/src/features/bids/bids.service.ts"],
  },
  {
    layer: "backend",
    task: "presign a private R2 url for an original photo and serve a blurred public CDN copy to locked viewers",
    expect: [
      "apps/backend/src/services/storage/index.ts",
      "apps/backend/src/features/media/media.service.ts",
      "apps/backend/src/features/requests/requests.service.ts",
    ],
  },
  {
    layer: "backend",
    task: "run Gemini damage assessment on uploaded photos and return a minimum repair cost estimate",
    expect: ["apps/backend/src/services/ai/damage-assessment.ts"],
  },
  {
    layer: "backend",
    task: "deduct a credit atomically when a shop unlocks a repair lead",
    expect: [
      "apps/backend/src/features/unlocks/unlocks.service.ts",
      "apps/backend/src/features/billings/billings.service.ts",
    ],
  },
  {
    layer: "mobile",
    task: "render the my-bids screen layout listing the shop's submitted bids with status badges",
    expect: ["apps/mobile/app/(shop)/my-bids.tsx"],
  },
  {
    layer: "mobile",
    task: "the bid store slice holding bid state and screen navigation on mobile",
    expect: ["apps/mobile/src/store/slices/bid-store.ts"],
  },
];

async function main() {
  const root = process.argv[2]
    ? path.resolve(process.argv[2])
    : (process.env.BENCH_REPO ?? process.cwd());
  const config = await loadConfig(root);
  const topN = config.topN;

  console.log(`\nEVAL  repo=${root}  topN(seeds)=${topN}`);
  if (process.env.CODEINDEX_NO_PKG_WEIGHT) console.log("MODE  package weighting DISABLED (baseline)");
  console.log("─".repeat(78));

  let pass = 0;
  let seedRankSum = 0; // sum of best target seed-rank (lower is better), for passing cases
  const byLayer: Record<string, { pass: number; total: number }> = {};

  for (const c of CASES) {
    const manifest = await retrieve(root, c.task);
    const seedFiles = (manifest.seedRanking ?? []).map((s) => s.file);
    const inManifest = c.expect.find((f) => manifest.entries.some((e) => e.file === f));

    // Best (lowest) seed-rank across the case's acceptable files; -1 if none is a seed.
    const seedRank = c.expect
      .map((f) => seedFiles.indexOf(f))
      .filter((r) => r >= 0)
      .sort((a, b) => a - b)[0] ?? -1;
    const ok = seedRank >= 0;
    if (ok) {
      pass++;
      seedRankSum += seedRank;
    }
    byLayer[c.layer] ??= { pass: 0, total: 0 };
    byLayer[c.layer].total++;
    if (ok) byLayer[c.layer].pass++;

    const target = ok ? seedFiles[seedRank] : inManifest ?? c.expect[0];
    const where = ok
      ? `seed #${seedRank}`
      : inManifest
        ? "manifest only (not seed)"
        : "ABSENT";
    console.log(`${ok ? "PASS" : "FAIL"} [${c.layer.padEnd(7)}] ${where.padEnd(24)} ${target}`);
    console.log(`         task: ${c.task}`);
  }

  console.log("─".repeat(78));
  const summary = Object.entries(byLayer)
    .map(([l, s]) => `${l} ${s.pass}/${s.total}`)
    .join("   ");
  const avgRank = pass ? (seedRankSum / pass).toFixed(2) : "n/a";
  console.log(`RESULT  ${pass}/${CASES.length} pass   (${summary})   avg seed-rank ${avgRank} (lower=better)\n`);
  process.exit(pass === CASES.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
