// Local, in-process dense embeddings. No Python, no API calls. Two backends,
// chosen by model id:
//   * Model2Vec static models (e.g. minishlab/potion-code-16M) -> StaticEmbedder
//     (token-vector lookup + mean pool; no transformer forward pass).
//   * everything else -> transformers.js feature-extraction pipeline (ONNX).
import path from "node:path";
import { StaticEmbedder } from "./static-embedder.js";

type FeatureExtractor = (
  text: string | string[],
  opts: { pooling: "mean" | "cls" | "none"; normalize: boolean },
) => Promise<{ data: Float32Array | number[]; dims: number[] }>;

let extractorPromise: Promise<FeatureExtractor> | null = null;
let loadedModel: string | null = null;

async function getExtractor(model: string): Promise<FeatureExtractor> {
  if (extractorPromise && loadedModel === model) return extractorPromise;
  loadedModel = model;
  extractorPromise = (async () => {
    // Dynamic import keeps the (heavy) ESM dependency off the module-load path.
    const tf = await import("@xenova/transformers");
    // Cache models under the index dir's sibling so re-runs are offline.
    tf.env.allowLocalModels = true;
    const pipe = await tf.pipeline("feature-extraction", model);
    return pipe as unknown as FeatureExtractor;
  })();
  return extractorPromise;
}

/** True for Model2Vec static models served from the local .models dir. */
export function isStaticModel(model: string): boolean {
  return /(^|\/)(potion|model2vec)/i.test(model) || model.startsWith("minishlab/");
}

const staticEmbedders = new Map<string, Promise<StaticEmbedder>>();
function getStaticEmbedder(model: string): Promise<StaticEmbedder> {
  let p = staticEmbedders.get(model);
  if (!p) {
    // Model files live under codeindex's .models/<basename> (offline, no Python).
    const modelDir = path.resolve(import.meta.dirname, "..", ".models", path.basename(model));
    p = new StaticEmbedder({ modelDir, modelId: path.basename(model) }).load();
    staticEmbedders.set(model, p);
  }
  return p;
}

/** Embed a single string -> normalized Float32Array (cosine == dot product). */
export async function embedText(text: string, model: string): Promise<Float32Array> {
  if (isStaticModel(model)) {
    return (await getStaticEmbedder(model)).embed(text);
  }
  const extractor = await getExtractor(model);
  const res = await extractor(text || " ", { pooling: "mean", normalize: true });
  return Float32Array.from(res.data as ArrayLike<number>);
}

/** Embed many strings sequentially (memory-stable at codebase scale). */
export async function embedBatch(
  texts: string[],
  model: string,
  onProgress?: (done: number, total: number) => void,
): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i++) {
    out.push(await embedText(texts[i], model));
    if (onProgress && (i % 25 === 0 || i === texts.length - 1)) onProgress(i + 1, texts.length);
  }
  return out;
}

/** Cosine similarity of two already-normalized vectors == dot product. */
export function cosineNormalized(a: Float32Array, b: Float32Array, offset = 0): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[offset + i];
  return dot;
}

/**
 * Rank rows of a flat (N*dims) normalized matrix against a normalized query vector.
 * Returns descending {row, score}.
 */
export function rankMatrix(
  matrix: Float32Array,
  dims: number,
  query: Float32Array,
  topK: number,
): { row: number; score: number }[] {
  const n = dims > 0 ? matrix.length / dims : 0;
  const scored: { row: number; score: number }[] = [];
  for (let r = 0; r < n; r++) {
    scored.push({ row: r, score: cosineNormalized(query, matrix, r * dims) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}
