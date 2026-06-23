// Node-native Model2Vec static embedder. No Python, no transformer forward pass.
//
// Faithful port of model2vec's StaticModel.encode for the *quantized* potion
// format. Per model.py the math is:
//
//   ids       = tokenize(text, add_special_tokens=false), drop unk, cap max_length
//   remapped  = mapping[id]                 (token id -> embedding row)
//   emb[i]    = embedding[remapped[i]] * weights[id_i]   (weights indexed by ORIGINAL id)
//   vec       = mean_i(emb[i])
//   vec       = vec / (||vec|| + 1e-32)     (when normalize)
//
// Tokenization reuses the tokenizer codeindex already ships (@xenova/transformers),
// so there is no new heavy dependency — only the static matrix is loaded directly.
import { promises as fs } from "node:fs";
import path from "node:path";

interface SafeTensor {
  dtype: string;
  shape: number[];
  data: Float32Array | Float64Array | BigInt64Array;
}

/** Minimal safetensors reader: [u64 header-len][JSON header][raw tensor block]. */
async function readSafetensors(file: string): Promise<Record<string, SafeTensor>> {
  const buf = await fs.readFile(file);
  const headerLen = Number(buf.readBigUint64LE(0));
  const header = JSON.parse(buf.toString("utf8", 8, 8 + headerLen));
  const base = 8 + headerLen;
  const out: Record<string, SafeTensor> = {};
  for (const [name, meta] of Object.entries<any>(header)) {
    if (name === "__metadata__") continue;
    const [start, end] = meta.data_offsets;
    const ab = buf.buffer.slice(buf.byteOffset + base + start, buf.byteOffset + base + end);
    const data =
      meta.dtype === "F32"
        ? new Float32Array(ab)
        : meta.dtype === "F64"
          ? new Float64Array(ab)
          : meta.dtype === "I64"
            ? new BigInt64Array(ab)
            : (() => {
                throw new Error(`unsupported dtype ${meta.dtype} for ${name}`);
              })();
    out[name] = { dtype: meta.dtype, shape: meta.shape, data };
  }
  return out;
}

type Tokenizer = (
  text: string,
  opts: { add_special_tokens: boolean },
) => Promise<{ input_ids: { data: ArrayLike<number | bigint> } }>;

export interface StaticEmbedderOptions {
  modelDir: string; // dir holding model.safetensors (+ tokenizer.json / config.json)
  modelId?: string; // HF id for the tokenizer (defaults to modelDir's basename owner)
  maxLength?: number; // token cap (model2vec default 512)
  unkTokenId?: number; // dropped before pooling (potion: 1)
  medianTokenLength?: number; // char pre-slice = maxLength * this (potion: 7)
}

export class StaticEmbedder {
  private embedding!: Float32Array;
  private weights!: Float64Array;
  private mapping!: BigInt64Array;
  private dim!: number;
  private normalize = true;
  private tokenizer!: Tokenizer;
  private readonly opts: Required<Omit<StaticEmbedderOptions, "modelId">> & { modelId?: string };

  constructor(opts: StaticEmbedderOptions) {
    this.opts = {
      maxLength: 512,
      unkTokenId: 1,
      medianTokenLength: 7,
      modelId: opts.modelId,
      modelDir: opts.modelDir,
    };
  }

  async load(): Promise<this> {
    const tensors = await readSafetensors(path.join(this.opts.modelDir, "model.safetensors"));
    this.embedding = tensors.embeddings.data as Float32Array;
    this.weights = tensors.weights.data as Float64Array;
    this.mapping = tensors.mapping.data as BigInt64Array;
    this.dim = tensors.embeddings.shape[1];

    try {
      const cfg = JSON.parse(await fs.readFile(path.join(this.opts.modelDir, "config.json"), "utf8"));
      if (typeof cfg.normalize === "boolean") this.normalize = cfg.normalize;
    } catch {
      /* default normalize=true */
    }

    // Tokenizer from the local dir (offline) via transformers.js.
    const tf = await import("@xenova/transformers");
    tf.env.allowLocalModels = true;
    tf.env.allowRemoteModels = false; // local-only: missing optional files won't hit the network
    tf.env.localModelPath = path.dirname(this.opts.modelDir);
    const id = this.opts.modelId ?? path.basename(this.opts.modelDir);
    this.tokenizer = (await tf.AutoTokenizer.from_pretrained(id)) as unknown as Tokenizer;
    return this;
  }

  /** Token ids for a text, matching model2vec.tokenize (no specials, drop unk, cap). */
  async tokenize(text: string): Promise<number[]> {
    const sliced = text.slice(0, this.opts.maxLength * this.opts.medianTokenLength);
    const enc = await this.tokenizer(sliced || " ", { add_special_tokens: false });
    const raw = Array.from(enc.input_ids.data, (x) => Number(x));
    const filtered = raw.filter((id) => id !== this.opts.unkTokenId);
    return filtered.slice(0, this.opts.maxLength);
  }

  async embed(text: string): Promise<Float32Array> {
    const ids = await this.tokenize(text);
    const acc = new Float64Array(this.dim);
    if (ids.length === 0) return Float32Array.from(acc);

    for (const id of ids) {
      const row = Number(this.mapping[id]); // token id -> embedding row
      const w = this.weights[id]; // weight indexed by original id
      const base = row * this.dim;
      for (let d = 0; d < this.dim; d++) acc[d] += this.embedding[base + d] * w;
    }
    const inv = 1 / ids.length;
    for (let d = 0; d < this.dim; d++) acc[d] *= inv;

    if (this.normalize) {
      let norm = 0;
      for (let d = 0; d < this.dim; d++) norm += acc[d] * acc[d];
      norm = Math.sqrt(norm) + 1e-32;
      for (let d = 0; d < this.dim; d++) acc[d] /= norm;
    }
    return Float32Array.from(acc);
  }

  get dimensions(): number {
    return this.dim;
  }
}
