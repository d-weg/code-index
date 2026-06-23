// Shared data model for the index and query path.

export type SymbolKind =
  | "function"
  | "class"
  | "method"
  | "interface"
  | "type"
  | "enum"
  | "const"
  | "doc";

export interface SymbolEntry {
  /** Stable id: `${file}#${name}@${startLine}`. */
  id: string;
  name: string;
  kind: SymbolKind;
  /** Repo-root-relative POSIX path. */
  file: string;
  /** Owning package name, or "root" for a single-package repo. */
  pkg: string;
  startLine: number;
  endLine: number;
  /** JSDoc / leading comment text, if any. */
  doc?: string;
  /** Short signature line, for the human summary. */
  signature?: string;
}

/** One embedding/BM25 chunk. Parallel-indexed with the embedding matrix rows. */
export interface ChunkMeta {
  id: string;
  symbol: string;
  kind: SymbolKind;
  file: string;
  pkg: string;
  startLine: number;
  endLine: number;
}

export interface GraphData {
  /** file -> files it imports (true definition sites, barrels resolved through). */
  forward: Record<string, string[]>;
  /** file -> files that import it. */
  reverse: Record<string, string[]>;
}

export interface PackageInfo {
  name: string;
  /** Repo-root-relative dir. */
  dir: string;
  /** Repo-root-relative tsconfig path. */
  tsconfig: string;
  /**
   * Role inferred at index time from the package's dependencies / tsconfig
   * (`backend | frontend | mobile | shared | docs | unknown`). Drives package-aware ranking
   * (§6.1) without the query path re-reading the repo. Overridable via `config.packageRoles`.
   */
  role?: string;
}

export interface WorkspaceInfo {
  root: string;
  isMonorepo: boolean;
  packages: PackageInfo[];
}

export interface FileRecord {
  mtimeMs: number;
  pkg: string;
}

export interface Config {
  embeddingModel: string;
  topN: number;
  graphHops: number;
  /** Cap on graph-expanded (non-seed) files in the manifest — prevents over-expansion on dense import graphs. */
  maxExpand: number;
  include: string[];
  exclude: string[];
  languages: string[];
  indexDocs: boolean;
  docGlobs: string[];
  adjacencyBonus: number;
  rrfK: number;
  indexDir: string;
  queryEmbedPrefix: string;
  /**
   * Static per-package (or per-role) multipliers applied to the fused score (§6.1).
   * Keys may be package names ("backend") or roles ("backend"/"mobile"/"shared"/…); a
   * name match wins over a role match. Absent ⇒ 1.0. A per-repo tuning floor.
   */
  packageWeights?: Record<string, number>;
  /** Override the auto-inferred role for a package (package name → role). */
  packageRoles?: Record<string, string>;
  /** Query-conditioned layer weighting: boost the package(s) whose role the task's terms imply. */
  queryLayerWeighting?: {
    enabled?: boolean;
    /** Multiplicative boost for the dominant query layer (e.g. 0.6 ⇒ ×1.6). */
    boost?: number;
    /** Override/extend the per-role trigger terms (merged over the built-in defaults). */
    terms?: Record<string, string[]>;
  };
}

/** Persisted BM25 document. */
export interface Bm25Doc {
  id: string;
  file: string;
  len: number;
  tf: Record<string, number>;
}

export interface Bm25Json {
  k1: number;
  b: number;
  docs: Bm25Doc[];
  df: Record<string, number>;
}

export interface IndexMeta {
  version: number;
  createdAt: string;
  updatedAt: string;
  model: string;
  dims: number;
  root: string;
  isMonorepo: boolean;
  packages: PackageInfo[];
  /** Dynamically detected workspace package names (from package.json / tsconfig analysis). */
  packageNames?: string[];
  files: Record<string, FileRecord>;
}

export interface ManifestEntry {
  file: string;
  pkg: string;
  matchedSymbols: { name: string; kind: SymbolKind; lineRange: [number, number] }[];
  reason: "query-match" | "imports-seed" | "imported-by-seed" | "doc";
  score: number;
  /** Present when the whole file is small enough to inline wholesale. */
  wholeFile?: boolean;
}

export interface Manifest {
  task: string;
  generatedAt: string;
  root: string;
  entries: ManifestEntry[];
  /**
   * The weighted-fused seed ranking (top-N) in selection order, before graph expansion and
   * the adjacency re-sort. This is exactly what package weighting steers, so it's the signal
   * to measure ranking changes against (see scripts/eval.ts). Optional/diagnostic.
   */
  seedRanking?: { file: string; score: number }[];
}
