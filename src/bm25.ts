import type { Bm25Doc, Bm25Json } from "./types.js";

const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "for", "on", "is", "this", "that",
  "it", "as", "with", "by", "be", "are", "from", "at", "if", "we", "you", "return", "const",
]);

/**
 * Tokenize code/text for lexical search. Lowercases, splits on non-alphanumerics,
 * and additionally splits camelCase / PascalCase / snake_case while keeping the
 * compound token too (so `buildIndex` matches `build`, `index`, and `buildindex`).
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const raw = text.split(/[^A-Za-z0-9]+/).filter(Boolean);
  for (const word of raw) {
    const lower = word.toLowerCase();
    if (lower.length > 1 && !STOP.has(lower)) out.push(lower);
    // split camelCase / digits boundaries
    const parts = word
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .split(/[\s_]+/)
      .filter(Boolean);
    if (parts.length > 1) {
      for (const p of parts) {
        const lp = p.toLowerCase();
        if (lp.length > 1 && !STOP.has(lp)) out.push(lp);
      }
    }
  }
  return out;
}

export class BM25 {
  k1 = 1.5;
  b = 0.75;
  private docs = new Map<string, Bm25Doc>();
  private df = new Map<string, number>();

  static fromJSON(json: Bm25Json): BM25 {
    const bm = new BM25();
    bm.k1 = json.k1;
    bm.b = json.b;
    for (const d of json.docs) bm.docs.set(d.id, d);
    for (const [t, c] of Object.entries(json.df)) bm.df.set(t, c);
    return bm;
  }

  toJSON(): Bm25Json {
    return {
      k1: this.k1,
      b: this.b,
      docs: [...this.docs.values()],
      df: Object.fromEntries(this.df),
    };
  }

  addDoc(id: string, file: string, tokens: string[]): void {
    if (this.docs.has(id)) this.removeDoc(id);
    const tf: Record<string, number> = {};
    for (const t of tokens) tf[t] = (tf[t] ?? 0) + 1;
    for (const t of Object.keys(tf)) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    this.docs.set(id, { id, file, len: tokens.length, tf });
  }

  removeDoc(id: string): void {
    const d = this.docs.get(id);
    if (!d) return;
    for (const t of Object.keys(d.tf)) {
      const c = (this.df.get(t) ?? 0) - 1;
      if (c <= 0) this.df.delete(t);
      else this.df.set(t, c);
    }
    this.docs.delete(id);
  }

  removeByFiles(files: Set<string>): void {
    for (const d of [...this.docs.values()]) {
      if (files.has(d.file)) this.removeDoc(d.id);
    }
  }

  private avgdl(): number {
    if (this.docs.size === 0) return 0;
    let total = 0;
    for (const d of this.docs.values()) total += d.len;
    return total / this.docs.size;
  }

  /** Ranked {id, score} for a tokenized query, descending score. */
  search(queryTokens: string[], topK = 50): { id: string; score: number }[] {
    const N = this.docs.size;
    if (N === 0) return [];
    const avgdl = this.avgdl();
    const qset = [...new Set(queryTokens)];
    const scored: { id: string; score: number }[] = [];
    for (const d of this.docs.values()) {
      let score = 0;
      for (const t of qset) {
        const f = d.tf[t];
        if (!f) continue;
        const n = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        const denom = f + this.k1 * (1 - this.b + (this.b * d.len) / (avgdl || 1));
        score += idf * ((f * (this.k1 + 1)) / denom);
      }
      if (score > 0) scored.push({ id: d.id, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }
}
