// Package-aware relevance weighting (ARCHITECTURE.md §6.1).
//
// Relevance is package-dependent: a "transaction/route/schema" task should favour the
// backend package; a "screen/layout/component" task should favour the mobile/frontend one.
// Every symbol is tagged with its owning `pkg`, so we can bias the fused score by package.
//
// Two composable mechanisms, both expressed as a multiplier on the fused score:
//
//   1. STATIC per-package (or per-role) weights — a config map (`packageWeights`). The
//      simplest viable lever; a per-repo floor that needs no query analysis.
//   2. QUERY-CONDITIONED layer boost — infer the task's target layer from its terms and
//      boost the packages whose *role* matches, for this query only. Repo-agnostic: it keys
//      off inferred package roles, not hardcoded package names, so the defaults generalise.
//
// The two are multiplied: `weight[pkg] = static[pkg] × (1 + boost·queryLayerMatch[pkg])`.
//
// WHY POST-FUSION (multiply the fused score) and not per-signal pre-RRF:
// RRF contributions are `1/(k+rank)` — rank-based and scale-free by design. Scaling a
// per-list score before fusion does not move an item's *rank* within that list, so a
// pre-RRF multiply is mostly a no-op on the fusion input; to actually re-order you would
// have to re-sort each list by weighted score, which couples the weight to every list's
// internal scale (the very thing RRF exists to avoid). Multiplying the single fused score
// is a clean, monotonic re-rank that steers seed selection directly. See retrieve.ts §3b.

export type PackageRole = "backend" | "frontend" | "mobile" | "shared" | "docs" | "unknown";

/** Roles that participate in query-conditioned weighting (every role except "unknown"). */
const KNOWN_ROLES: Exclude<PackageRole, "unknown">[] = [
  "backend",
  "frontend",
  "mobile",
  "shared",
  "docs",
];

/** Everything we can learn about a package to classify its role — gathered at index time. */
export interface RoleSignals {
  name: string;
  dir: string;
  /** Dependency names (dependencies + devDependencies), lowercased. The strongest signal. */
  deps?: string[];
  /** `compilerOptions.lib` from the package's tsconfig, lowercased. */
  tsLib?: string[];
  /** `compilerOptions.types` from the package's tsconfig, lowercased. */
  tsTypes?: string[];
}

/**
 * Dependency fingerprints, in priority order. A package's role is read from what it actually
 * depends on — far more robust than matching its name/dir. Each entry's `deps` are matched as
 * package-name prefixes (so `expo` matches `expo-router`, `@aws-sdk/` matches every AWS client).
 * Mobile is checked first because RN apps also pull in `react`/`react-dom` (react-native-web).
 */
const DEP_FINGERPRINTS: { role: Exclude<PackageRole, "unknown" | "docs">; deps: string[] }[] = [
  {
    role: "mobile",
    deps: ["react-native", "expo", "@expo/", "@react-navigation/", "@react-native", "nativewind"],
  },
  {
    role: "frontend",
    deps: ["next", "nuxt", "vite", "@vitejs/", "vue", "svelte", "@sveltejs/", "@angular/",
      "react-dom", "react-router-dom", "gatsby", "@remix-run/", "astro"],
  },
  {
    role: "backend",
    deps: ["express", "fastify", "elysia", "hono", "koa", "@nestjs/", "@hapi/", "drizzle-orm",
      "drizzle-kit", "prisma", "@prisma/", "mongoose", "typeorm", "sequelize", "knex", "pg",
      "postgres", "mysql", "mysql2", "@aws-sdk/", "firebase-admin", "ioredis", "bullmq",
      "kafkajs", "@trpc/server", "apollo-server", "graphql-yoga"],
  },
];

const depMatches = (deps: string[], prefixes: string[]): boolean =>
  deps.some((d) => prefixes.some((p) => d === p || d.startsWith(p) || d.startsWith(`${p}-`)));

/** Last-resort heuristic over the package name/dir, when deps/tsconfig are inconclusive. */
function inferRoleFromNameDir(name: string, dir: string): PackageRole {
  const hay = `${name} ${dir}`.toLowerCase();
  const has = (...needles: string[]) => needles.some((n) => hay.includes(n));
  if (has("mobile", "expo", "react-native", "native", "/app")) return "mobile";
  if (has("backend", "server", "/api", "worker", "lambda", "functions")) return "backend";
  if (has("frontend", "web", "client", "www", "dashboard", "admin", "site")) return "frontend";
  if (has("docs", "documentation")) return "docs";
  if (has("shared", "common", "core", "types", "schema", "lib", "util", "packages/")) return "shared";
  return "unknown";
}

/**
 * Infer a package's role — no per-repo config required. Preference order:
 *   1. dependency fingerprints (what it imports defines what it is);
 *   2. tsconfig hints (`lib: ["dom"]` ⇒ web; `types: ["bun-types"|"node"]` ⇒ backend);
 *   3. name/dir substring fallback.
 * Overridable per package via `config.packageRoles`.
 */
export function inferRole(signals: RoleSignals): PackageRole {
  const deps = signals.deps ?? [];
  if (deps.length) {
    for (const fp of DEP_FINGERPRINTS) if (depMatches(deps, fp.deps)) return fp.role;
  }
  const tsTypes = signals.tsTypes ?? [];
  if (tsTypes.some((t) => t === "bun-types" || t === "node")) return "backend";
  const tsLib = signals.tsLib ?? [];
  if (tsLib.some((l) => l.startsWith("dom"))) return "frontend";
  return inferRoleFromNameDir(signals.name, signals.dir);
}

/**
 * Default query-term → role triggers. A query token "hits" a role when it shares a prefix
 * with one of the role's terms (so "atomically"→atomic, "presigned"→presign, "screens"→
 * screen all match). Terms are architectural/layer vocabulary, not domain words.
 */
export const DEFAULT_LAYER_TERMS: Record<Exclude<PackageRole, "unknown">, string[]> = {
  backend: [
    "route", "router", "controller", "service", "endpoint", "api", "handler",
    "transaction", "atomic", "schema", "migration", "drizzle", "sql", "query",
    "db", "database", "table", "column", "index", "constraint", "unique",
    "presign", "bucket", "storage", "upload", "cdn", "webhook", "cron", "queue",
    "worker", "middleware", "auth", "token", "credit", "billing", "payment",
    "deduct", "balance", "ledger", "invoice", "server",
  ],
  frontend: [
    "page", "css", "dom", "browser", "spa", "ssr", "hydrate", "vite", "webpack",
    "router", "route", "fetch", "form",
  ],
  mobile: [
    "screen", "layout", "component", "tap", "press", "gesture", "scroll",
    "navigation", "navigator", "navigate", "view", "render", "style", "stylesheet",
    "expo", "native", "tab", "modal", "sheet", "drawer", "safearea", "keyboard",
    "animation", "animated", "flatlist", "touchable", "pressable",
  ],
  shared: [
    "type", "interface", "enum", "constant", "shared", "util", "helper", "dto",
  ],
  docs: ["readme", "documentation", "guide", "changelog"],
};

export interface QueryLayerWeighting {
  enabled?: boolean;
  /** Multiplicative boost for the dominant layer (e.g. 0.6 ⇒ ×1.6). */
  boost?: number;
  /** Override/extend the per-role trigger terms. Merged over the defaults per role. */
  terms?: Partial<Record<string, string[]>>;
}

export interface PackageWeightConfig {
  /** Static multipliers keyed by package name OR role. Default 1.0. */
  packageWeights?: Record<string, number>;
  /** Override the inferred role for a package (name → role). */
  packageRoles?: Record<string, string>;
  /** Query-conditioned layer weighting. */
  queryLayerWeighting?: QueryLayerWeighting;
}

/**
 * A package as seen by the weighter. `role` is the role precomputed at index time (from deps/
 * tsconfig); when absent it is inferred on the fly from whatever signals are present. Keeping
 * the precomputed role on the index means the query path does no filesystem work.
 */
export interface WeightedPackage extends RoleSignals {
  role?: PackageRole | string;
}

export interface PackageWeightInput {
  packages: WeightedPackage[];
  /** Tokenized query (already lowercased / camel-split, e.g. from `tokenize(task)`). */
  queryTokens: string[];
  config: PackageWeightConfig;
}

export interface PackageWeightResult {
  /** Final multiplier per package name. */
  weight: Record<string, number>;
  /** Per-package debug breakdown. */
  debug: {
    roles: Record<string, PackageRole>;
    /** Raw per-role term-hit counts from the query. */
    layerScores: Record<string, number>;
    /** The dominant query layer(s) that fired, if any. */
    firedLayers: PackageRole[];
  };
}

const isKnownRole = (r: string | undefined): r is PackageRole =>
  !!r && (r === "unknown" || (KNOWN_ROLES as string[]).includes(r));

const resolveRole = (pkg: WeightedPackage, overrides?: Record<string, string>): PackageRole => {
  const o = overrides?.[pkg.name];
  if (o && isKnownRole(o)) return o; // explicit config override wins
  if (isKnownRole(pkg.role) && pkg.role !== "unknown") return pkg.role; // precomputed at index time
  return inferRole(pkg); // infer from whatever signals we have
};

/**
 * Does any query token match a layer term? A match is exact, or the query token extends the
 * term as a prefix (so "atomically"→atomic, "presigned"→presign, "screens"→screen all hit).
 * Only the query-extends-term direction is used — matching the other way round turns "handle"
 * into a hit for "handler", which leaks cross-layer boosts.
 */
const termHits = (qtokens: Set<string>, term: string): boolean => {
  for (const qt of qtokens) {
    if (qt === term) return true;
    if (term.length >= 4 && qt.startsWith(term)) return true;
  }
  return false;
};

/**
 * Compute the per-package fused-score multiplier from static config weights and
 * query-conditioned layer inference. Pure and deterministic — unit-testable in isolation.
 */
export function computePackageWeights(input: PackageWeightInput): PackageWeightResult {
  const { packages, queryTokens, config } = input;
  const qset = new Set(queryTokens);

  const roles: Record<string, PackageRole> = {};
  for (const p of packages) roles[p.name] = resolveRole(p, config.packageRoles);

  // --- Query-conditioned layer scores: count unique role-terms the query hits. ---
  const qlw = config.queryLayerWeighting ?? {};
  const enabled = qlw.enabled ?? true;
  const boost = qlw.boost ?? 0.6;
  const layerScores: Record<string, number> = {};
  let maxLayer = 0;
  if (enabled) {
    for (const role of KNOWN_ROLES) {
      const terms = new Set([...(DEFAULT_LAYER_TERMS[role] ?? []), ...(qlw.terms?.[role] ?? [])]);
      let hits = 0;
      for (const t of terms) if (termHits(qset, t)) hits++;
      layerScores[role] = hits;
      if (hits > maxLayer) maxLayer = hits;
    }
  }
  const firedLayers = (KNOWN_ROLES as PackageRole[]).filter((r) => (layerScores[r] ?? 0) > 0);

  // --- Compose: static × query-conditioned, per package. ---
  const weight: Record<string, number> = {};
  for (const p of packages) {
    const role = roles[p.name];
    const staticW =
      config.packageWeights?.[p.name] ?? (config.packageWeights?.[role] ?? 1.0);
    let mult = 1.0;
    if (enabled && maxLayer > 0) {
      const ls = layerScores[role] ?? 0;
      if (ls > 0) mult = 1 + boost * (ls / maxLayer);
    }
    weight[p.name] = staticW * mult;
  }

  return { weight, debug: { roles, layerScores, firedLayers } };
}
