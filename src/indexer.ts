import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import { Project, type SourceFile } from "ts-morph";
import { BM25, tokenize } from "./bm25.js";
import { loadConfig } from "./config.js";
import { embedBatch } from "./embeddings.js";
import { buildGraph, computeForwardEdges, deriveReverse, type GraphContext } from "./import-graph.js";
import { extractFromSourceFile, type ExtractedChunk } from "./symbols.js";
import { indexExists, loadIndex, saveIndex, type IndexData } from "./store.js";
import type { ChunkMeta, Config, IndexMeta, SymbolEntry } from "./types.js";
import { detectWorkspace, packageForFile } from "./workspace.js";
import { isIgnored, loadGitignore, makeMatcher, relPosix } from "./util.js";

const log = (...a: unknown[]) => console.error("[codeindex]", ...a);

function getProject(root: string, tsconfigRel: string, pkgDir: string, config: Config): Project {
  const tsconfigAbs = path.resolve(root, tsconfigRel);
  if (existsSync(tsconfigAbs)) {
    return new Project({ tsConfigFilePath: tsconfigAbs });
  }
  // Fallback: no tsconfig — load include globs under the package dir.
  const proj = new Project({ compilerOptions: { allowJs: false, target: 99 } });
  const prefix = pkgDir === "." ? "" : pkgDir + "/";
  proj.addSourceFilesAtPaths(config.include.map((g) => prefix + g));
  return proj;
}

function isTsFile(rel: string): boolean {
  return /\.tsx?$/.test(rel) && !rel.endsWith(".d.ts");
}

/** packageName -> (exported symbol name -> defining files) for cross-package resolution. */
function buildSymbolIndex(symbols: SymbolEntry[]): Map<string, Map<string, string[]>> {
  const m = new Map<string, Map<string, string[]>>();
  for (const s of symbols) {
    if (s.kind === "method" || s.kind === "doc") continue;
    let pm = m.get(s.pkg);
    if (!pm) m.set(s.pkg, (pm = new Map()));
    let arr = pm.get(s.name);
    if (!arr) pm.set(s.name, (arr = []));
    if (!arr.includes(s.file)) arr.push(s.file);
  }
  return m;
}

/** Split a markdown file into heading sections -> doc chunks. */
function extractDocChunks(rel: string, content: string): ExtractedChunk[] {
  const lines = content.split("\n");
  const sections: { title: string; start: number; body: string[] }[] = [];
  let cur = { title: path.basename(rel), start: 1, body: [] as string[] };
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,3})\s+(.+)/);
    if (m) {
      if (cur.body.some((l) => l.trim())) sections.push(cur);
      cur = { title: m[2].trim(), start: i + 1, body: [] };
    }
    cur.body.push(lines[i]);
  }
  if (cur.body.some((l) => l.trim())) sections.push(cur);

  return sections.map((s) => {
    const endLine = s.start + s.body.length - 1;
    const name = `${path.basename(rel)}:${s.title}`.slice(0, 80);
    const entry: SymbolEntry = {
      id: `${rel}#${s.title}@${s.start}`,
      name,
      kind: "doc",
      file: rel,
      pkg: "docs",
      startLine: s.start,
      endLine,
      signature: s.title.slice(0, 140),
    };
    return { entry, text: `doc ${s.title}\n${s.body.join("\n")}`.slice(0, 1500) };
  });
}

interface Collected {
  symbols: SymbolEntry[];
  chunks: ExtractedChunk[];
  tsFiles: Map<string, { sf: SourceFile; pkg: string }>;
  files: Record<string, { mtimeMs: number; pkg: string }>;
}

async function collectAll(root: string, config: Config): Promise<{ ws: Awaited<ReturnType<typeof detectWorkspace>>; collected: Collected }> {
  const ws = await detectWorkspace(root);
  const ig = await loadGitignore(root);
  const includeMatch = makeMatcher(config.include);
  const excludeMatch = makeMatcher(config.exclude);

  const collected: Collected = { symbols: [], chunks: [], tsFiles: new Map(), files: {} };

  // TS sources, one Project per package (correct tsconfig + path aliases).
  for (const pkg of ws.packages) {
    const project = getProject(root, pkg.tsconfig, pkg.dir, config);
    for (const sf of project.getSourceFiles()) {
      const rel = relPosix(root, sf.getFilePath());
      if (!isTsFile(rel)) continue;
      if (!includeMatch(rel) || excludeMatch(rel) || isIgnored(ig, rel)) continue;
      const owner = packageForFile(ws, rel);
      if (owner.name !== pkg.name) continue; // handled by its true owner's project
      if (collected.tsFiles.has(rel)) continue;
      const chunks = extractFromSourceFile(sf, rel, owner.name);
      collected.symbols.push(...chunks.map((c) => c.entry));
      collected.chunks.push(...chunks);
      collected.tsFiles.set(rel, { sf, pkg: owner.name });
      const st = await fs.stat(sf.getFilePath());
      collected.files[rel] = { mtimeMs: st.mtimeMs, pkg: owner.name };
    }
  }

  // Docs.
  if (config.indexDocs) {
    const docPaths = await fg(config.docGlobs, {
      cwd: root,
      ignore: config.exclude,
      onlyFiles: true,
      dot: false,
    });
    for (const rel of docPaths) {
      if (excludeMatch(rel) || isIgnored(ig, rel)) continue;
      const abs = path.resolve(root, rel);
      const content = await fs.readFile(abs, "utf8");
      const chunks = extractDocChunks(rel, content);
      collected.symbols.push(...chunks.map((c) => c.entry));
      collected.chunks.push(...chunks);
      const st = await fs.stat(abs);
      collected.files[rel] = { mtimeMs: st.mtimeMs, pkg: "docs" };
    }
  }

  return { ws, collected };
}

function flatten(vectors: Float32Array[], dims: number): Float32Array {
  const out = new Float32Array(vectors.length * dims);
  for (let i = 0; i < vectors.length; i++) out.set(vectors[i], i * dims);
  return out;
}

/** Full offline build. */
export async function buildAll(root: string): Promise<void> {
  const config = await loadConfig(root);
  log("detecting workspace…");
  const { ws, collected } = await collectAll(root, config);
  log(`workspace: ${ws.isMonorepo ? "monorepo" : "single"} · ${ws.packages.length} package(s) · ${collected.tsFiles.size} ts files · ${collected.chunks.length} chunks`);

  log("embedding chunks (first run downloads the model)…");
  const texts = collected.chunks.map((c) => c.text);
  const vecs = await embedBatch(texts, config.embeddingModel, (d, t) => log(`  embedded ${d}/${t}`));
  const dims = vecs.length ? vecs[0].length : 384;
  const vectors = flatten(vecs, dims);

  const chunkMetas: ChunkMeta[] = collected.chunks.map((c) => ({
    id: c.entry.id,
    symbol: c.entry.name,
    kind: c.entry.kind,
    file: c.entry.file,
    pkg: c.entry.pkg,
    startLine: c.entry.startLine,
    endLine: c.entry.endLine,
  }));

  const bm25 = new BM25();
  for (const c of collected.chunks) bm25.addDoc(c.entry.id, c.entry.file, tokenize(c.text));

  // Import graph.
  const indexed = new Set(collected.tsFiles.keys());
  const ctx: GraphContext = {
    symbolIndexByPkg: buildSymbolIndex(collected.symbols),
    workspacePkgNames: ws.packages.map((p) => p.name).sort((a, b) => b.length - a.length),
  };
  const forward: Record<string, string[]> = {};
  for (const [rel, { sf }] of collected.tsFiles) {
    const edges = computeForwardEdges(sf, root, indexed, ctx);
    if (edges.length) forward[rel] = edges;
  }

  const now = new Date().toISOString();
  const meta: IndexMeta = {
    version: 1,
    createdAt: now,
    updatedAt: now,
    model: config.embeddingModel,
    dims,
    root,
    isMonorepo: ws.isMonorepo,
    packages: ws.packages,
    packageNames: ws.packages.map((p) => p.name),
    files: collected.files,
  };

  const data: IndexData = { meta, symbols: collected.symbols, chunks: chunkMetas, vectors, forward, graph: buildGraph(forward), bm25 };
  await saveIndex(root, config, data);
  log(`done. index written to ${path.join(config.indexDir)}/`);
}

/** Incremental update for a set of changed/deleted files. */
export async function updateFiles(root: string, inputFiles: string[]): Promise<void> {
  const config = await loadConfig(root);
  if (!(await indexExists(root, config))) {
    log("no index yet — running full build");
    return buildAll(root);
  }
  const data = await loadIndex(root, config);
  const ws = await detectWorkspace(root);
  const ig = await loadGitignore(root);
  const includeMatch = makeMatcher(config.include);
  const excludeMatch = makeMatcher(config.exclude);
  const docMatch = makeMatcher(config.docGlobs);

  // Normalize inputs to repo-relative posix; classify changed vs deleted.
  const affected = new Set<string>();
  const changedTs: string[] = [];
  const changedDocs: string[] = [];
  const deleted = new Set<string>();
  for (const f of inputFiles) {
    const abs = path.isAbsolute(f) ? f : path.resolve(root, f);
    const rel = relPosix(root, abs);
    if (!rel || rel.startsWith("..")) continue;
    if (isIgnored(ig, rel)) continue;
    const exists = existsSync(abs);
    const isTs = isTsFile(rel) && includeMatch(rel) && !excludeMatch(rel);
    const isDoc = config.indexDocs && docMatch(rel) && !excludeMatch(rel);
    if (!isTs && !isDoc) continue;
    affected.add(rel);
    if (!exists) deleted.add(rel);
    else if (isTs) changedTs.push(rel);
    else changedDocs.push(rel);
  }
  if (affected.size === 0) {
    log("no indexable files in update set — nothing to do");
    return;
  }
  log(`update: ${changedTs.length} ts, ${changedDocs.length} docs, ${deleted.size} deleted`);

  // Re-extract changed TS via each owner package's Project (correct config).
  const newChunks: ExtractedChunk[] = [];
  const reloadedSf = new Map<string, SourceFile>();
  const byPkg = new Map<string, string[]>();
  for (const rel of changedTs) {
    const owner = packageForFile(ws, rel);
    (byPkg.get(owner.tsconfig) ?? byPkg.set(owner.tsconfig, []).get(owner.tsconfig)!).push(rel);
  }
  for (const [tsconfig, rels] of byPkg) {
    const pkg = ws.packages.find((p) => p.tsconfig === tsconfig)!;
    const project = getProject(root, tsconfig, pkg.dir, config);
    for (const rel of rels) {
      const sf = project.getSourceFile(path.resolve(root, rel)) ?? project.addSourceFileAtPathIfExists(path.resolve(root, rel)) ?? undefined;
      if (!sf) continue;
      reloadedSf.set(rel, sf);
      const owner = packageForFile(ws, rel);
      const chunks = extractFromSourceFile(sf, rel, owner.name);
      newChunks.push(...chunks);
    }
  }
  for (const rel of changedDocs) {
    const content = await fs.readFile(path.resolve(root, rel), "utf8");
    newChunks.push(...extractDocChunks(rel, content));
  }

  // Rebuild symbols.
  const symbols = data.symbols.filter((s) => !affected.has(s.file));
  symbols.push(...newChunks.map((c) => c.entry));

  // Rebuild chunks + vectors: keep unaffected rows, append re-embedded new ones.
  const dims = data.meta.dims;
  const keptChunks: ChunkMeta[] = [];
  const keptVecRows: number[] = [];
  for (let i = 0; i < data.chunks.length; i++) {
    if (!affected.has(data.chunks[i].file)) {
      keptChunks.push(data.chunks[i]);
      keptVecRows.push(i);
    }
  }
  log(`re-embedding ${newChunks.length} new chunks…`);
  const newVecs = await embedBatch(newChunks.map((c) => c.text), config.embeddingModel);
  const newChunkMetas: ChunkMeta[] = newChunks.map((c) => ({
    id: c.entry.id, symbol: c.entry.name, kind: c.entry.kind, file: c.entry.file,
    pkg: c.entry.pkg, startLine: c.entry.startLine, endLine: c.entry.endLine,
  }));
  const finalChunks = [...keptChunks, ...newChunkMetas];
  const finalVectors = new Float32Array(finalChunks.length * dims);
  for (let i = 0; i < keptVecRows.length; i++) {
    finalVectors.set(data.vectors.subarray(keptVecRows[i] * dims, keptVecRows[i] * dims + dims), i * dims);
  }
  for (let i = 0; i < newVecs.length; i++) {
    finalVectors.set(newVecs[i], (keptChunks.length + i) * dims);
  }

  // BM25 incremental.
  data.bm25.removeByFiles(affected);
  for (const c of newChunks) data.bm25.addDoc(c.entry.id, c.entry.file, tokenize(c.text));

  // Graph: prune deleted, recompute forward edges for changed TS files.
  const indexed = new Set(Object.keys(data.meta.files).filter(isTsFile));
  for (const d of deleted) indexed.delete(d);
  for (const rel of changedTs) indexed.add(rel);
  const ctx: GraphContext = {
    symbolIndexByPkg: buildSymbolIndex(symbols),
    workspacePkgNames: ws.packages.map((p) => p.name).sort((a, b) => b.length - a.length),
  };
  const forward = { ...data.forward };
  for (const d of deleted) delete forward[d];
  for (const rel of changedTs) {
    const sf = reloadedSf.get(rel);
    if (!sf) continue;
    const edges = computeForwardEdges(sf, root, indexed, ctx);
    if (edges.length) forward[rel] = edges;
    else delete forward[rel];
  }
  // Drop deleted files from everyone's forward list.
  if (deleted.size) {
    for (const k of Object.keys(forward)) {
      const filtered = forward[k].filter((t) => !deleted.has(t));
      if (filtered.length) forward[k] = filtered;
      else delete forward[k];
    }
  }

  // Meta.
  const files = { ...data.meta.files };
  for (const d of deleted) delete files[d];
  for (const rel of changedTs) {
    const st = await fs.stat(path.resolve(root, rel));
    files[rel] = { mtimeMs: st.mtimeMs, pkg: packageForFile(ws, rel).name };
  }
  for (const rel of changedDocs) {
    const st = await fs.stat(path.resolve(root, rel));
    files[rel] = { mtimeMs: st.mtimeMs, pkg: "docs" };
  }
  const meta: IndexMeta = { ...data.meta, updatedAt: new Date().toISOString(), files };

  await saveIndex(root, config, {
    meta, symbols, chunks: finalChunks, vectors: finalVectors, forward, graph: buildGraph(forward), bm25: data.bm25,
  });
  log("update complete");
}

export { deriveReverse };
