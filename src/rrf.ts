// Reciprocal Rank Fusion: parameter-free merge of multiple ranked lists.
// score(item) = sum over lists of 1 / (k + rank), rank starting at 1.

export function reciprocalRankFusion(
  lists: string[][],
  k = 60,
): Map<string, number> {
  const fused = new Map<string, number>();
  for (const list of lists) {
    for (let i = 0; i < list.length; i++) {
      const id = list[i];
      const contribution = 1 / (k + (i + 1));
      fused.set(id, (fused.get(id) ?? 0) + contribution);
    }
  }
  return fused;
}

export function sortedByScore(fused: Map<string, number>): { id: string; score: number }[] {
  return [...fused.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}
