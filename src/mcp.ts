#!/usr/bin/env -S npx tsx
// MCP server exposing `retrieve_context` over stdio. Launch one per repo:
//   codeindex-mcp --root /path/to/repo
// Any MCP-capable agent (Claude Code, Claude Desktop, internal agents) can then call it.

import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { renderSummary } from "./retrieve.js";
import { makeRetrieveContextHandler, RETRIEVE_CONTEXT_TOOL } from "./tool.js";

function resolveRoot(): string {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--root");
  if (i !== -1 && argv[i + 1]) return path.resolve(argv[i + 1]);
  if (process.env.CODEINDEX_ROOT) return path.resolve(process.env.CODEINDEX_ROOT);
  return process.cwd();
}

async function main() {
  const root = resolveRoot();
  const handle = makeRetrieveContextHandler(root);

  const server = new McpServer({ name: "codeindex", version: "0.1.0" });

  server.registerTool(
    RETRIEVE_CONTEXT_TOOL.name,
    {
      title: "Retrieve Context",
      description: RETRIEVE_CONTEXT_TOOL.description,
      inputSchema: {
        task: z.string().describe("What you're trying to do."),
        topN: z.number().int().positive().optional().describe("Seed files (default 8)."),
        hops: z.number().int().nonnegative().optional().describe("Graph hops (default 2)."),
      },
    },
    async ({ task, topN, hops }) => {
      try {
        const manifest = await handle({ task, topN, hops });
        // Human-readable summary as text, full manifest as JSON — both useful to an agent.
        return {
          content: [
            { type: "text", text: renderSummary(manifest) },
            { type: "text", text: JSON.stringify(manifest) },
          ],
        };
      } catch (e) {
        return {
          isError: true,
          content: [{ type: "text", text: `retrieve_context failed: ${e instanceof Error ? e.message : e}` }],
        };
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr so we don't corrupt the stdio JSON-RPC channel.
  console.error(`[codeindex-mcp] serving retrieve_context for ${root}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
