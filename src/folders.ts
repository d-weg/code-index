// Folder / architecture metadata — zero-API. Derives, from file structure +
// co-located docs alone (no model calls): per-directory file-kind patterns,
// detected "module templates" (sibling dirs that repeat a file shape), and any
// co-located README/AGENTS/CLAUDE doc. Tells an agent WHERE a new file/module goes
// and what shape it should take before CREATE_FILE.
import fg from "fast-glob";
import { promises as fs } from "node:fs";
import path from "node:path";
import { isIgnored, loadGitignore } from "./util.js";

/** Safety cap: a real project tree, not someone's whole home directory. */
const MAX_ARCH_FILES = 20000;

export interface ArchNode {
  dir: string; // relative to root ("" = repo root)
  files: number;
  /** filename pattern histogram, e.g. { ".service.ts": 3, "index": 1, ".tsx": 5 } */
  suffixes: Record<string, number>;
  doc: string | null; // co-located README/AGENTS/CLAUDE/ARCHITECTURE
  /** if this dir is a module container: the file shape its sub-modules repeat */
  template: string[] | null;
  moduleCount: number; // sub-modules matching the template (when template != null)
}

const DOC_NAMES = ["README.md", "AGENTS.md", "CLAUDE.md", "ARCHITECTURE.md"];

/** foo.service.ts → ".service.ts" · index.ts → "index" · Bar.tsx → ".tsx" */
function fileSuffix(name: string): string {
  if (/^index\.tsx?$/.test(name)) return "index";
  const m = /\.([A-Za-z0-9-]+)\.(tsx?)$/.exec(name);
  if (m) return `.${m[1]}.${m[2]}`;
  return path.extname(name) || name;
}

export async function buildArchitecture(root: string): Promise<ArchNode[]> {
  const ig = await loadGitignore(root);
  const globbed = await fg(["**/*.ts", "**/*.tsx"], {
    cwd: root,
    ignore: ["**/node_modules/**", "**/dist/**", "**/build/**", "**/*.d.ts", "**/.codeindex/**", "**/.git/**"],
    followSymbolicLinks: false,
    suppressErrors: true,
    deep: 12,
  });
  const files = globbed.filter((f) => !isIgnored(ig, f));
  if (files.length > MAX_ARCH_FILES) {
    throw new Error(
      `architecture scan found ${files.length} TS files under ${root} (cap ${MAX_ARCH_FILES}). ` +
        `Point this at an actual project root (--root / CODEINDEX_ROOT) or pass a narrower path.`,
    );
  }

  const byDir = new Map<string, string[]>();
  for (const f of files) {
    const d = path.dirname(f) === "." ? "" : path.dirname(f);
    const arr = byDir.get(d) ?? [];
    arr.push(path.basename(f));
    byDir.set(d, arr);
  }
  const suffixSetOf = (d: string) => new Set((byDir.get(d) ?? []).map(fileSuffix));

  const nodes: ArchNode[] = [];
  for (const [d, names] of byDir) {
    const suffixes: Record<string, number> = {};
    for (const n of names) suffixes[fileSuffix(n)] = (suffixes[fileSuffix(n)] ?? 0) + 1;

    let doc: string | null = null;
    for (const dn of DOC_NAMES) {
      try {
        await fs.access(path.join(root, d, dn));
        doc = dn;
        break;
      } catch {
        /* not present */
      }
    }

    // Module container: immediate child dirs that repeat a file shape.
    const childDirs = [...byDir.keys()].filter((cd) => cd !== d && (d === "" ? !cd.includes("/") : path.dirname(cd) === d));
    let template: string[] | null = null;
    let moduleCount = 0;
    if (childDirs.length >= 2) {
      const counts = new Map<string, number>();
      for (const cd of childDirs) for (const s of suffixSetOf(cd)) counts.set(s, (counts.get(s) ?? 0) + 1);
      const common = [...counts.entries()]
        .filter(([, c]) => c >= Math.ceil(childDirs.length / 2))
        .map(([s]) => s)
        .sort();
      if (common.length >= 2) {
        template = common;
        moduleCount = childDirs.length;
      }
    }
    nodes.push({ dir: d, files: names.length, suffixes, doc, template, moduleCount });
  }
  nodes.sort((a, b) => a.dir.localeCompare(b.dir));
  return nodes;
}

export function formatArchitecture(nodes: ArchNode[], subpath?: string): string {
  const filtered = subpath ? nodes.filter((n) => n.dir === subpath || n.dir.startsWith(subpath + "/")) : nodes;
  if (filtered.length === 0) return "(no source directories found)";
  const lines: string[] = [];
  for (const n of filtered) {
    const top = Object.entries(n.suffixes)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([s, c]) => `${s}×${c}`)
      .join(", ");
    let line = `${n.dir || "."}/  (${n.files} files: ${top})`;
    if (n.doc) line += `  [doc: ${n.doc}]`;
    if (n.template) line += `\n    ↳ module container: ${n.moduleCount} sub-modules, each ~ { ${n.template.join(", ")} }`;
    lines.push(line);
  }
  return lines.join("\n");
}
