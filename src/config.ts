import { promises as fs } from "node:fs";
import path from "node:path";
import type { Config } from "./types.js";

export const DEFAULT_CONFIG: Config = {
  embeddingModel: "Xenova/bge-small-en-v1.5",
  topN: 8,
  graphHops: 2,
  maxExpand: 10,
  include: ["**/*.ts", "**/*.tsx"],
  exclude: ["**/node_modules/**", "**/dist/**", "**/build/**", "**/*.d.ts", "**/.codeindex/**"],
  languages: ["ts", "tsx"],
  indexDocs: true,
  docGlobs: ["**/*.md", "**/*.mdx"],
  adjacencyBonus: 0.4,
  rrfK: 60,
  indexDir: ".codeindex",
  queryEmbedPrefix: "Represent this sentence for searching relevant code: ",
  // Package-aware ranking (§6.1). Query-conditioned weighting is on by default because it is
  // repo-agnostic (keys off inferred package roles, not hardcoded names). Static
  // `packageWeights` is left empty — opt-in per-repo tuning.
  queryLayerWeighting: { enabled: true, boost: 0.6 },
};

/** Load codeindex.config.json from the repo root, merged over defaults. */
export async function loadConfig(root: string): Promise<Config> {
  const candidates = ["codeindex.config.json", ".codeindexrc.json"];
  for (const name of candidates) {
    const p = path.join(root, name);
    try {
      const raw = await fs.readFile(p, "utf8");
      return { ...DEFAULT_CONFIG, ...(JSON.parse(raw) as Partial<Config>) };
    } catch {
      // try next candidate
    }
  }
  return { ...DEFAULT_CONFIG };
}
