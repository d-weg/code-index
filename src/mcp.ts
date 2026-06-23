#!/usr/bin/env -S npx tsx
// MCP server over stdio. Exposes the INPUT tool (retrieve_context) and the OUTPUT
// tools (apply_edits, list_anchors). Launch one per repo:
//   codeindex-mcp --root /path/to/repo     (or CODEINDEX_ROOT, or cwd)
// Any MCP-capable agent (Claude Code, Claude Desktop) can then call them.

import path from "node:path";
import { z } from "zod";
import { Project } from "ts-morph";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { renderSummary } from "./retrieve.js";
import { makeRetrieveContextHandler, RETRIEVE_CONTEXT_TOOL } from "./tool.js";
import { commit, parseOps } from "./edit/index.js";
import { indexSourceFile } from "./edit/nodeId.js";

function resolveRoot(): string {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--root");
  if (i !== -1 && argv[i + 1]) return path.resolve(argv[i + 1]);
  if (process.env.CODEINDEX_ROOT) return path.resolve(process.env.CODEINDEX_ROOT);
  return process.cwd();
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const err = (t: string) => ({ isError: true, content: [{ type: "text" as const, text: t }] });

const APPLY_EDITS_DESC = `Apply structural code edits to THIS TypeScript repo through AST anchors. Every edit
is type-checked first: if it would introduce a NEW type error, nothing is written
and the errors are returned so you can fix and call again. Prefer this over manual
multi-file str_replace for renames and structural changes.

Provide \`ops\` as one or more blocks:

  CRITICAL_REFACTOR: RENAME <nodeId> TO <newName>
    Renames the symbol AND all imports/call-sites repo-wide (one directive).

  STRUCTURAL_EDIT: <nodeId>
  ACTION: SET_BODY | REPLACE_NODE | INSERT_BEFORE
  CODE:
  <code>

  STRUCTURAL_EDIT: <nodeId>
  ACTION: REPLACE_TEXT
  OLD:
  <exact span, unique within the node>
  NEW:
  <replacement>

nodeId = relativePath#<prefix>_<name>; prefixes: fn_ cls_ iface_ enum_ type_ var_,
and meth_Class.method. Call list_anchors first to get exact nodeIds.
SET_BODY = body only (signature kept); REPLACE_NODE = whole declaration (signature
changes); REPLACE_TEXT = small localized edit; INSERT_BEFORE = new declaration;
RENAME = cross-file rename. Pass \`tsconfig\` (the package's tsconfig, e.g.
apps/backend/tsconfig.json) in a monorepo; defaults to tsconfig.json at the root.
Set \`dryRun\` to validate without writing.`;

async function main() {
  const root = resolveRoot();
  const handleRetrieve = makeRetrieveContextHandler(root);
  const server = new McpServer({ name: "codeindex", version: "0.1.0" });
  const resolveTsconfig = (tsconfig?: string) =>
    tsconfig
      ? path.isAbsolute(tsconfig)
        ? tsconfig
        : path.join(root, tsconfig)
      : path.join(root, "tsconfig.json");

  // ── INPUT: retrieve_context ────────────────────────────────────────────────
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
        const manifest = await handleRetrieve({ task, topN, hops });
        return { content: [
          { type: "text", text: renderSummary(manifest) },
          { type: "text", text: JSON.stringify(manifest) },
        ] };
      } catch (e) {
        return err(`retrieve_context failed: ${e instanceof Error ? e.message : e}`);
      }
    },
  );

  // ── OUTPUT: list_anchors ───────────────────────────────────────────────────
  server.registerTool(
    "list_anchors",
    {
      title: "List AST Anchors",
      description:
        "List the AST anchors (nodeIds) and line ranges in a TypeScript file, so you " +
        "can target them precisely with apply_edits. Input: file path relative to the repo root.",
      inputSchema: { file: z.string().describe("File path relative to the repo root.") },
    },
    async ({ file }) => {
      try {
        const abs = path.isAbsolute(file) ? file : path.join(root, file);
        const project = new Project({ compilerOptions: { allowJs: true } });
        const sf = project.addSourceFileAtPath(abs);
        const rel = path.relative(root, abs);
        const anchors = [...indexSourceFile(sf, rel).entries()].map(
          ([id, node]) => `${id}  (L${node.getStartLineNumber()}-${node.getEndLineNumber()})`,
        );
        return text(anchors.length ? anchors.join("\n") : "(no indexable top-level nodes)");
      } catch (e) {
        return err(`list_anchors failed: ${e instanceof Error ? e.message : e}`);
      }
    },
  );

  // ── OUTPUT: apply_edits ────────────────────────────────────────────────────
  server.registerTool(
    "apply_edits",
    {
      title: "Apply Structural Edits",
      description: APPLY_EDITS_DESC,
      inputSchema: {
        ops: z.string().describe("Edit ops in the protocol (RENAME / STRUCTURAL_EDIT blocks)."),
        tsconfig: z.string().optional().describe("tsconfig path (relative to root or absolute). Default <root>/tsconfig.json."),
        dryRun: z.boolean().optional().describe("Validate through the gate without writing to disk."),
      },
    },
    async ({ ops, tsconfig, dryRun }) => {
      try {
        const project = new Project({ tsConfigFilePath: resolveTsconfig(tsconfig) });
        const parsed = parseOps(ops);
        if (parsed.length === 0) return err("No ops parsed. Check the protocol format.");
        const res = await commit(project, parsed, {
          write: !dryRun,
          fullProjectLoaded: true, // loaded from tsconfig => full graph, safe for RENAME
          baselineDiff: true, // only fail on NEWLY introduced type errors
        });
        if (res.ok) {
          return text(
            `Applied ${res.appliedOps} op(s)${dryRun ? " (dry run — nothing written)" : ""}. ` +
              `Changed ${res.changedFiles.length} file(s):\n` +
              res.changedFiles.map((f) => path.relative(root, f)).join("\n"),
          );
        }
        return err(
          `Edit rejected — nothing written (failed at op #${res.failedOpIndex}). ` +
            `Fix and call again.\n\n${res.feedback}`,
        );
      } catch (e) {
        return err(`apply_edits failed: ${e instanceof Error ? e.message : e}`);
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[codeindex-mcp] retrieve_context + apply_edits + list_anchors for ${root}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
