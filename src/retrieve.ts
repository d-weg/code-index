import { promises as fs } from "node:fs";
import path from "node:path";
import { tokenize } from "./bm25.js";
import { loadConfig } from "./config.js";
import { embedText, rankMatrix } from "./embeddings.js";
import { reciprocalRankFusion, sortedByScore } from "./rrf.js";
import { computePackageWeights } from "./package-weight.js";
import { indexExists, loadIndex } from "./store.js";
import type { ChunkMeta, GraphData, Manifest, ManifestEntry, SymbolEntry, SymbolKind } from "./types.js";

interface MatchedSym {
  name: string;
  kind: SymbolKind;
  lineRange: [number, number];
}

const isDocFile = (f: string) => /\.mdx?$/.test(f);

/** Ordered unique file list from a ranked list of chunk rows. */
function filesFromRows(rows: { row: number }[], chunks: ChunkMeta[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const { row } of rows) {
    const f = chunks[row]?.file;
    if (f && !seen.has(f)) {
      seen.add(f);
      out.push(f);
    }
  }
  return out;
}

/** Direct symbol-name match → ranked file list (best-scoring symbol per file wins). */
function symbolNameSearch(symbols: SymbolEntry[], qTokens: string[], qRaw: string): string[] {
  const q = new Set(qTokens);
  const ql = qRaw.toLowerCase();
  const bestPerFile = new Map<string, number>();
  for (const s of symbols) {
    if (s.kind === "doc") continue;
    const nameTokens = tokenize(s.name);
    let score = 0;
    for (const t of nameTokens) if (q.has(t)) score += 1;
    if (ql.includes(s.name.toLowerCase()) && s.name.length >= 3) score += 2;
    if (score <= 0) continue;
    if (score > (bestPerFile.get(s.file) ?? 0)) bestPerFile.set(s.file, score);
  }
  return [...bestPerFile.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
}

/** Expand seeds 1..hops along the import graph, both directions, tagging the relationship. */
function expandGraph(
  seeds: string[],
  graph: GraphData,
  hops: number,
): Map<string, { reason: "imports-seed" | "imported-by-seed"; hop: number }> {
  const result = new Map<string, { reason: "imports-seed" | "imported-by-seed"; hop: number }>();
  const visited = new Set(seeds);
  let frontier = new Set(seeds);
  for (let h = 1; h <= hops; h++) {
    const next = new Set<string>();
    for (const f of frontier) {
      for (const imp of graph.forward[f] ?? []) {
        if (!visited.has(imp)) {
          visited.add(imp);
          next.add(imp);
          if (!result.has(imp)) result.set(imp, { reason: "imported-by-seed", hop: h });
        }
      }
      for (const rev of graph.reverse[f] ?? []) {
        if (!visited.has(rev)) {
          visited.add(rev);
          next.add(rev);
          if (!result.has(rev)) result.set(rev, { reason: "imports-seed", hop: h });
        }
      }
    }
    frontier = next;
  }
  return result;
}

/** Count how many seeds a file is import-adjacent to (1 hop, either direction). */
function adjacencyToSeeds(file: string, seeds: Set<string>, graph: GraphData): number {
  const fwd = new Set(graph.forward[file] ?? []);
  const rev = new Set(graph.reverse[file] ?? []);
  let c = 0;
  for (const s of seeds) {
    if (s === file) continue;
    if (fwd.has(s) || rev.has(s)) c++;
  }
  return c;
}

export interface RetrieveOptions {
  topN?: number;
  hops?: number;
  maxExpand?: number;
}

export async function retrieve(root: string, task: string, opts: RetrieveOptions = {}): Promise<Manifest> {
  const config = await loadConfig(root);
  if (!(await indexExists(root, config))) {
    throw new Error(`No index at ${path.join(root, config.indexDir)} — run \`codeindex\` first.`);
  }
  const data = await loadIndex(root, config);
  const topN = opts.topN ?? config.topN;
  const hops = opts.hops ?? config.graphHops;
  const maxExpand = opts.maxExpand ?? config.maxExpand ?? 10;

  // 1. Embed the query (with the retrieval instruction prefix for bge models).
  const qVec = await embedText(config.queryEmbedPrefix + task, config.embeddingModel);

  // 2. Three searches.
  const vecRows = rankMatrix(data.vectors, data.meta.dims, qVec, 80);
  const vecFiles = filesFromRows(vecRows, data.chunks);

  const qTokens = tokenize(task);
  const bmHits = data.bm25.search(qTokens, 80);
  const idToChunk = new Map(data.chunks.map((c) => [c.id, c] as const));
  const bmFiles: string[] = [];
  const seenBm = new Set<string>();
  for (const h of bmHits) {
    const f = idToChunk.get(h.id)?.file;
    if (f && !seenBm.has(f)) {
      seenBm.add(f);
      bmFiles.push(f);
    }
  }

  const symFiles = symbolNameSearch(data.symbols, qTokens, task);

  // 3. Reciprocal Rank Fusion.
  const fused = reciprocalRankFusion([vecFiles, bmFiles, symFiles], config.rrfK);

  // 3b. Package-aware weighting (§6.1, see package-weight.ts). Compose a per-package
  // multiplier from (1) static config weights and (2) a query-conditioned layer boost that
  // infers the task's target layer ("transaction/route/schema/atomic" → backend, "screen/
  // layout/component/tap" → mobile) from its terms and boosts the matching package's role.
  // Applied to the fused score POST-RRF (not per-signal pre-fusion): RRF is rank-based, so a
  // pre-fusion multiply wouldn't re-order a list without re-sorting it by a scale RRF is
  // designed to ignore — multiplying the single fused score is the clean monotonic re-rank.
  // Roles were inferred from each package's deps/tsconfig at index time and persisted on
  // meta.packages, so the query path does no filesystem work (falls back to name/dir if absent).
  const packages = data.meta.packages.map((p) => ({ name: p.name, dir: p.dir, role: p.role }));
  const { weight, debug } = computePackageWeights({
    packages,
    queryTokens: qTokens,
    config,
  });

  // Escape hatch for A/B baselining (scripts/eval.ts) — disable all package weighting.
  const pkgWeightOff = !!process.env.CODEINDEX_NO_PKG_WEIGHT;
  const pkgOf = (file: string): string => data.meta.files[file]?.pkg ?? "";
  const weightFor = (file: string): number => (pkgWeightOff ? 1.0 : weight[pkgOf(file)] ?? 1.0);

  if (process.env.CODEINDEX_DEBUG) {
    const nonUnit = Object.entries(weight)
      .filter(([, w]) => w !== 1)
      .map(([p, w]) => `${p}=${w.toFixed(2)}`);
    const fired = debug.firedLayers.length ? debug.firedLayers.join("+") : "none";
    console.error(
      `[codeindex] query layer=${fired}  package weights: ${nonUnit.join(" ") || "(all 1.0 — no signal fired)"}`,
    );
  }

  // Apply the package weight to the fused score BEFORE seed selection, so weighting steers
  // which files become seeds — not just the final sort of an already-fixed candidate set.
  const weightedFused = new Map<string, number>();
  for (const [file, s] of fused) weightedFused.set(file, s * weightFor(file));
  const fusedSorted = sortedByScore(weightedFused);

  if (process.env.CODEINDEX_DEBUG) {
    console.error("[codeindex] top weighted-fused:");
    for (const { id, score } of fusedSorted.slice(0, 15)) {
      console.error(`  ${score.toFixed(4)}  [${pkgOf(id)}] ${id}`);
    }
  }

  // 4. Seeds + graph expansion.
  const seeds = fusedSorted.slice(0, topN).map((x) => x.id);
  const seedSet = new Set(seeds);
  const expanded = expandGraph(seeds, data.graph, hops);

  // Collect matched symbols per file (from the top vector rows + symbol-name matches).
  const matched = new Map<string, MatchedSym[]>();
  const pushMatch = (file: string, m: MatchedSym) => {
    const arr = matched.get(file) ?? [];
    if (arr.length < 6 && !arr.some((x) => x.name === m.name && x.lineRange[0] === m.lineRange[0])) {
      arr.push(m);
      matched.set(file, arr);
    }
  };
  for (const { row } of vecRows.slice(0, 40)) {
    const c = data.chunks[row];
    if (c && c.kind !== "doc") pushMatch(c.file, { name: c.symbol, kind: c.kind, lineRange: [c.startLine, c.endLine] });
  }

  // 5. Scoring: fused + graph-adjacency bonus.
  const candidates = new Set<string>([...seeds, ...expanded.keys()]);
  const seedEntries: ManifestEntry[] = [];
  const expEntries: ManifestEntry[] = [];
  for (const file of candidates) {
    const isSeed = seedSet.has(file);
    const exp = expanded.get(file);
    if (!isSeed && !exp) continue;

    const base = weightedFused.get(file) ?? 0;
    const adj = adjacencyToSeeds(file, seedSet, data.graph);
    const score = base + config.adjacencyBonus * adj;

    let reason: ManifestEntry["reason"];
    if (isSeed) reason = isDocFile(file) ? "doc" : "query-match";
    else reason = exp!.reason;

    const ms = matched.get(file) ?? [];
    const pkg = data.meta.files[file]?.pkg ?? data.chunks.find((c) => c.file === file)?.pkg ?? "root";
    const entry: ManifestEntry = { file, pkg, matchedSymbols: ms, reason, score };

    // Inline whole small files instead of line-ranges.
    try {
      const content = await fs.readFile(path.resolve(root, file), "utf8");
      if (content.split("\n").length <= 50) entry.wholeFile = true;
    } catch {
      /* file may be gone */
    }
    (isSeed ? seedEntries : expEntries).push(entry);
  }

  // Seeds are always kept; graph-expanded files are ranked and capped so a dense
  // import graph can't flood the manifest with weakly-related neighbors. A file that
  // is both search-matched (base > 0) and import-adjacent (adj bonus) ranks highest.
  expEntries.sort((a, b) => b.score - a.score);
  const entries = [...seedEntries, ...expEntries.slice(0, maxExpand)].sort((a, b) => b.score - a.score);

  const seedRanking = fusedSorted.slice(0, topN).map((x) => ({ file: x.id, score: x.score }));
  return { task, generatedAt: new Date().toISOString(), root, entries, seedRanking };
}

export function renderSummary(manifest: Manifest): string {
  const lines: string[] = [];
  lines.push(`# Context manifest for: "${manifest.task}"`);
  lines.push(`# ${manifest.entries.length} files · ${manifest.root}`);
  lines.push("");
  for (const e of manifest.entries) {
    const tag = e.reason.padEnd(16);
    lines.push(`${tag} ${e.score.toFixed(3)}  ${e.file}${e.wholeFile ? "  (whole file)" : ""}`);
    for (const m of e.matchedSymbols) {
      lines.push(`                          ↳ ${m.kind} ${m.name}  L${m.lineRange[0]}-${m.lineRange[1]}`);
    }
  }
  return lines.join("\n");
}

// ---- CLI ----
async function main() {
  const argv = process.argv.slice(2);
  let root = process.cwd();
  let json = false;
  let topN: number | undefined;
  let hops: number | undefined;
  const taskParts: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") root = path.resolve(argv[++i]);
    else if (a === "--json") json = true;
    else if (a === "--top") topN = Number(argv[++i]);
    else if (a === "--hops") hops = Number(argv[++i]);
    else taskParts.push(a);
  }
  const task = taskParts.join(" ").trim();
  if (!task) {
    console.error('Usage: codeindex-retrieve "<task>" [--json] [--top N] [--hops N] [--root DIR]');
    process.exit(1);
  }
  const manifest = await retrieve(root, task, { topN, hops });
  if (json) process.stdout.write(JSON.stringify(manifest, null, 2) + "\n");
  else process.stdout.write(renderSummary(manifest) + "\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
