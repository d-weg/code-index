import { promises as fs } from "node:fs";
import path from "node:path";
import { BM25 } from "./bm25.js";
import { buildGraph } from "./import-graph.js";
import type { ChunkMeta, Config, GraphData, IndexMeta, SymbolEntry } from "./types.js";
import { pathExists } from "./util.js";

export interface IndexData {
  meta: IndexMeta;
  symbols: SymbolEntry[];
  chunks: ChunkMeta[];
  vectors: Float32Array; // chunks.length * meta.dims, row-aligned with `chunks`
  forward: Record<string, string[]>;
  graph: GraphData; // forward + derived reverse
  bm25: BM25;
}

const FILES = {
  meta: "meta.json",
  symbols: "symbols.json",
  chunks: "chunks.json",
  forward: "graph.json",
  bm25: "bm25.json",
  vectors: "embeddings.bin",
} as const;

export function indexDir(root: string, config: Config): string {
  return path.join(root, config.indexDir);
}

export async function indexExists(root: string, config: Config): Promise<boolean> {
  return pathExists(path.join(indexDir(root, config), FILES.meta));
}

export async function saveIndex(root: string, config: Config, data: IndexData): Promise<void> {
  const dir = indexDir(root, config);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, FILES.meta), JSON.stringify(data.meta, null, 2));
  await fs.writeFile(path.join(dir, FILES.symbols), JSON.stringify(data.symbols));
  await fs.writeFile(path.join(dir, FILES.chunks), JSON.stringify(data.chunks));
  await fs.writeFile(path.join(dir, FILES.forward), JSON.stringify(data.forward));
  await fs.writeFile(path.join(dir, FILES.bm25), JSON.stringify(data.bm25.toJSON()));
  const buf = Buffer.from(
    data.vectors.buffer,
    data.vectors.byteOffset,
    data.vectors.byteLength,
  );
  await fs.writeFile(path.join(dir, FILES.vectors), buf);
  // A small config snapshot aids debugging / reproducibility.
  await fs.writeFile(path.join(dir, "config.snapshot.json"), JSON.stringify(config, null, 2));
}

export async function loadIndex(root: string, config: Config): Promise<IndexData> {
  const dir = indexDir(root, config);
  const meta = JSON.parse(await fs.readFile(path.join(dir, FILES.meta), "utf8")) as IndexMeta;
  const symbols = JSON.parse(await fs.readFile(path.join(dir, FILES.symbols), "utf8")) as SymbolEntry[];
  const chunks = JSON.parse(await fs.readFile(path.join(dir, FILES.chunks), "utf8")) as ChunkMeta[];
  const forward = JSON.parse(await fs.readFile(path.join(dir, FILES.forward), "utf8")) as Record<
    string,
    string[]
  >;
  const bm25 = BM25.fromJSON(JSON.parse(await fs.readFile(path.join(dir, FILES.bm25), "utf8")));

  const raw = await fs.readFile(path.join(dir, FILES.vectors));
  // Copy out of the (possibly pooled) Buffer into a clean ArrayBuffer.
  const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  const vectors = new Float32Array(ab);

  return { meta, symbols, chunks, vectors, forward, graph: buildGraph(forward), bm25 };
}
