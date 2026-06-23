// Verify the Node StaticEmbedder reproduces the Python model2vec reference,
// vector-for-vector. Ground truth = .data/parity.json (written by run-potion side).
import { promises as fs } from "node:fs";
import path from "node:path";
import { StaticEmbedder } from "../../src/static-embedder.js";

const DATA = path.join(import.meta.dirname, ".data");
const MODEL_DIR = path.resolve(import.meta.dirname, "../../.models/potion-code-16M");

function cosine(a: number[] | Float32Array, b: number[] | Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
const maxAbs = (a: Float32Array, b: number[]) =>
  Math.max(...Array.from(a, (x, i) => Math.abs(x - b[i])));

async function main() {
  const fx = JSON.parse(await fs.readFile(path.join(DATA, "parity.json"), "utf8"));
  const m = await new StaticEmbedder({ modelDir: MODEL_DIR, modelId: "potion-code-16M" }).load();
  console.log(`dims JS=${m.dimensions} py=${fx.dims}\n`);

  let worstCos = 1, tokOk = true;
  for (let i = 0; i < fx.samples.length; i++) {
    const ids = await m.tokenize(fx.samples[i]);
    const vec = await m.embed(fx.samples[i]);
    const idsMatch = ids.length === fx.tokenIds[i].length && ids.every((v, j) => v === fx.tokenIds[i][j]);
    tokOk &&= idsMatch;
    const cos = cosine(vec, fx.vectors[i]);
    worstCos = Math.min(worstCos, cos);
    console.log(`sample ${i}: tokens ${idsMatch ? "MATCH" : "DIFFER"} (${ids.length}), cosine=${cos.toFixed(8)}, maxAbsΔ=${maxAbs(vec, fx.vectors[i]).toExponential(2)}`);
    if (!idsMatch) console.log(`   js : ${ids.slice(0, 20).join(",")}\n   py : ${fx.tokenIds[i].slice(0, 20).join(",")}`);
  }
  console.log("─".repeat(60));
  const pass = tokOk && worstCos > 0.99999;
  console.log(`tokens ${tokOk ? "✓" : "✗"}   worst cosine ${worstCos.toFixed(8)}   => ${pass ? "PARITY ✓" : "MISMATCH ✗"}`);
  process.exit(pass ? 0 : 1);
}

main();
