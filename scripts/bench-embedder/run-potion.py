#!/usr/bin/env python3
# Potion side of the embedder comparison. Consumes the IDENTICAL chunk texts +
# queries the BGE side dumped, embeds with potion-code-16M (model2vec, parity),
# dense-ranks, and writes results_potion.json. Only the embedder differs.
import json, os, time
import numpy as np
from model2vec import StaticModel

DATA = os.path.join(os.path.dirname(__file__), ".data")
MODEL = "minishlab/potion-code-16M"


def load(name):
    with open(os.path.join(DATA, name)) as f:
        return json.load(f)


def rank_files(qv, mat, files):
    scores = mat @ qv  # vectors are normalized -> cosine == dot
    order = np.argsort(-scores)
    seen, out = set(), []
    for i in order:
        f = files[i]
        if f not in seen:
            seen.add(f)
            out.append(f)
    return out


def main():
    chunks = load("chunk_texts.json")
    queries = load("queries.json")
    texts, files = chunks["texts"], chunks["files"]

    print(f"[potion] loading {MODEL}...")
    m = StaticModel.from_pretrained(MODEL)

    print(f"[potion] embedding {len(texts)} chunks...")
    t0 = time.time()
    mat = np.asarray(m.encode(texts), dtype=np.float32)
    # normalize (model already normalizes, but be safe for dot==cosine)
    mat /= (np.linalg.norm(mat, axis=1, keepdims=True) + 1e-9)
    embed_ms = (time.time() - t0) * 1000

    results = []
    q_ms = 0.0
    for c in queries:
        tq = time.time()
        qv = np.asarray(m.encode([c["task"]]), dtype=np.float32)[0]
        qv /= np.linalg.norm(qv) + 1e-9
        q_ms += (time.time() - tq) * 1000
        ranked = rank_files(qv, mat, files)
        ranks = [ranked.index(f) for f in c["expect"] if f in ranked]
        rank = min(ranks) if ranks else -1
        results.append({"task": c["task"], "layer": c["layer"], "rank": rank})

    out = {
        "model": MODEL,
        "dims": int(mat.shape[1]),
        "embedMs": round(embed_ms),
        "queryMsAvg": q_ms / len(queries),
        "results": results,
    }
    with open(os.path.join(DATA, "results_potion.json"), "w") as f:
        json.dump(out, f, indent=2)
    print(
        f"[potion] done. chunk-embed {embed_ms:.0f}ms "
        f"({embed_ms/len(texts):.2f}ms/chunk), query {q_ms/len(queries):.2f}ms avg"
    )


if __name__ == "__main__":
    main()
