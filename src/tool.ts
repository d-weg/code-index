// Framework-agnostic tool surface: a JSON-schema tool definition + a handler factory.
// Usable directly with the Anthropic SDK tool runner, or wrapped by the MCP server.

import { retrieve } from "./retrieve.js";
import type { Manifest } from "./types.js";

export const RETRIEVE_CONTEXT_TOOL = {
  name: "retrieve_context",
  description:
    "Return a compact manifest of the files and symbol line-ranges relevant to a task, from a " +
    "local precomputed code index (BM25 + dense vectors + import graph, zero API calls). " +
    "Call this FIRST — before grep/glob/read exploration — whenever you need to find where " +
    "something lives in the codebase or decide what to read to implement a change. It returns " +
    "files with specific line-ranges, not whole files: read only the ranges it points at. " +
    "Each entry has a `reason` (query-match | imports-seed | imported-by-seed | doc) and a score.",
  input_schema: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description: "What you're trying to do, e.g. 'add rate limiting to the upload route'.",
      },
      topN: { type: "integer", description: "Seed files before graph expansion (default 8)." },
      hops: { type: "integer", description: "Import-graph expansion hops (default 2)." },
    },
    required: ["task"],
  },
} as const;

export interface RetrieveContextInput {
  task: string;
  topN?: number;
  hops?: number;
}

/** Build a handler bound to a repo root. Returns the manifest object. */
export function makeRetrieveContextHandler(root: string) {
  return (input: RetrieveContextInput): Promise<Manifest> =>
    retrieve(root, input.task, { topN: input.topN, hops: input.hops });
}
