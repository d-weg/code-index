// BGE side of the embedder comparison (the production path: transformers.js).
// 1. Reconstruct chunk text from the the test repo index metas + source (same recipe as
//    src/symbols.ts: `${kind} ${name}\n${body[:1500]}`).
// 2. Embed chunks + queries with bge-small via embedText.
// 3. Dense-rank chunks -> dedupe to files -> rank of each case's expected file.
// 4. Dump chunk_texts.json + queries.json for the Python/potion side, and write
//    results_bge.json.
import { promises as fs } from "node:fs";
import path from "node:path";
import { embedText } from "../../src/embeddings.js";
import { loadConfig } from "../../src/config.js";
import { CASES, REPO } from "./cases.js";

const DATA = path.join(import.meta.dirname, ".data");
const BODY_CHARS = 1500;
const QUERY_PREFIX = "Represent this sentence for searching relevant code: ";

interface ChunkMeta {
  symbol: string;
  kind: string;
  file: string;
  startLine: number;
  endLine: number;
}

const fileCache = new Map<string, string[] | null>();
async function lines(file: string): Promise<string[] | null> {
  if (fileCache.has(file)) return fileCache.get(file)!;
  let v: string[] | null = null;
  try {
    v = (await fs.readFile(path.join(REPO, file), "utf8")).split("\n");
  } catch {
    v = null;
  }
  fileCache.set(file, v);
  return v;
}

async function chunkText(c: ChunkMeta): Promise<string> {
  const ls = await lines(c.file);
  const body = ls ? ls.slice(c.startLine - 1, c.endLine).join("\n") : "";
  return `${c.kind} ${c.symbol}\n${body}`.slice(0, BODY_CHARS);
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** Dense file ranking for a query vector. Returns ordered unique file list. */
function rankFiles(q: Float32Array, vecs: Float32Array[], files: string[]): string[] {
  const scored = vecs.map((v, i) => ({ i, s: dot(q, v) }));
  scored.sort((a, b) => b.s - a.s);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const { i } of scored) {
    const f = files[i];
    if (!seen.has(f)) {
      seen.add(f);
      out.push(f);
    }
  }
  return out;
}

async function main() {
  const config = await loadConfig(REPO);
  const metas: ChunkMeta[] = JSON.parse(
    await fs.readFile(path.join(REPO, config.indexDir, "chunks.json"), "utf8"),
  );

  console.log(`[bge] reconstructing ${metas.length} chunk texts...`);
  const texts: string[] = [];
  const files: string[] = [];
  for (const c of metas) {
    texts.push(await chunkText(c));
    files.push(c.file);
  }
  // Hand the identical texts + queries to the potion side.
  await fs.writeFile(path.join(DATA, "chunk_texts.json"), JSON.stringify({ texts, files }));
  await fs.writeFile(
    path.join(DATA, "queries.json"),
    JSON.stringify(CASES.map((c) => ({ task: c.task, expect: c.expect, layer: c.layer }))),
  );

  console.log(`[bge] embedding chunks with ${config.embeddingModel}...`);
  const t0 = Date.now();
  const vecs: Float32Array[] = [];
  for (let i = 0; i < texts.length; i++) {
    vecs.push(await embedText(texts[i], config.embeddingModel));
    if (i % 100 === 0) console.log(`  ${i}/${texts.length}`);
  }
  const embedMs = Date.now() - t0;

  console.log(`[bge] ranking ${CASES.length} queries...`);
  const results = [];
  let qMs = 0;
  for (const c of CASES) {
    const tq = Date.now();
    const qv = await embedText(QUERY_PREFIX + c.task, config.embeddingModel);
    qMs += Date.now() - tq;
    const ranked = rankFiles(qv, vecs, files);
    const ranks = c.expect.map((f) => ranked.indexOf(f)).filter((r) => r >= 0);
    const rank = ranks.length ? Math.min(...ranks) : -1;
    results.push({ task: c.task, layer: c.layer, rank });
  }

  await fs.writeFile(
    path.join(DATA, "results_bge.json"),
    JSON.stringify(
      { model: config.embeddingModel, dims: vecs[0].length, embedMs, queryMsAvg: qMs / CASES.length, results },
      null,
      2,
    ),
  );
  console.log(
    `[bge] done. chunk-embed ${embedMs}ms (${(embedMs / texts.length).toFixed(1)}ms/chunk), query ${(qMs / CASES.length).toFixed(1)}ms avg`,
  );
}

main();
