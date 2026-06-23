import { type ImportDeclaration, type SourceFile, type Symbol as MorphSymbol } from "ts-morph";
import type { GraphData } from "./types.js";
import { relPosix } from "./util.js";

export interface GraphContext {
  /** packageName -> (exportedSymbolName -> defining files) — for cross-package fallback. */
  symbolIndexByPkg: Map<string, Map<string, string[]>>;
  /** Workspace package names (e.g. "@scope/pkg"), longest first. */
  workspacePkgNames: string[];
}

/** Follow the full alias chain to the true definition symbol (barrels included). */
function resolveAliased(sym: MorphSymbol | undefined): MorphSymbol | undefined {
  let real = sym;
  for (let i = 0; i < 6 && real; i++) {
    try {
      const aliased = real.getAliasedSymbol();
      if (aliased && aliased !== real) real = aliased;
      else break;
    } catch {
      break;
    }
  }
  return real;
}

function declFiles(root: string, sym: MorphSymbol | undefined, indexed: Set<string>, out: Set<string>) {
  const real = resolveAliased(sym);
  if (!real) return;
  for (const d of real.getDeclarations() ?? []) {
    const f = relPosix(root, d.getSourceFile().getFilePath());
    if (indexed.has(f)) out.add(f);
  }
}

/** Resolve one import declaration to the true definition files it points at. */
function resolveImportDecl(
  imp: ImportDeclaration,
  root: string,
  indexed: Set<string>,
  ctx: GraphContext,
): string[] {
  const targets = new Set<string>();

  // Named imports: resolve each through aliases -> true def site (barrel pass-through).
  for (const spec of imp.getNamedImports()) {
    declFiles(root, spec.getNameNode().getSymbol(), indexed, targets);
  }
  const def = imp.getDefaultImport();
  if (def) declFiles(root, def.getSymbol(), indexed, targets);
  const ns = imp.getNamespaceImport();
  if (ns) declFiles(root, ns.getSymbol(), indexed, targets);

  // Fallback to the literal module file (still skips barrels conceptually because we
  // only add it when named resolution found nothing).
  if (targets.size === 0) {
    const msf = imp.getModuleSpecifierSourceFile();
    if (msf) {
      const f = relPosix(root, msf.getFilePath());
      if (indexed.has(f)) targets.add(f);
    }
  }

  // Cross-package fallback: specifier is a workspace package whose source we indexed,
  // but module resolution landed in dist/node_modules. Map named imports by symbol name.
  if (targets.size === 0) {
    const spec = imp.getModuleSpecifierValue();
    const pkgName = ctx.workspacePkgNames.find((n) => spec === n || spec.startsWith(n + "/"));
    if (pkgName) {
      const symIndex = ctx.symbolIndexByPkg.get(pkgName);
      if (symIndex) {
        for (const named of imp.getNamedImports()) {
          const files = symIndex.get(named.getName());
          if (files) for (const f of files) targets.add(f);
        }
      }
    }
  }

  return [...targets];
}

/** Forward edges (files this file imports) for a single source file. */
export function computeForwardEdges(
  sf: SourceFile,
  root: string,
  indexed: Set<string>,
  ctx: GraphContext,
): string[] {
  const self = relPosix(root, sf.getFilePath());
  const targets = new Set<string>();
  for (const imp of sf.getImportDeclarations()) {
    for (const t of resolveImportDecl(imp, root, indexed, ctx)) {
      if (t !== self) targets.add(t);
    }
  }
  return [...targets].sort();
}

/** Derive the reverse adjacency (file -> importers) from a forward map. */
export function deriveReverse(forward: Record<string, string[]>): Record<string, string[]> {
  const reverse: Record<string, Set<string>> = {};
  for (const [from, tos] of Object.entries(forward)) {
    for (const to of tos) {
      (reverse[to] ??= new Set()).add(from);
    }
  }
  const out: Record<string, string[]> = {};
  for (const [k, set] of Object.entries(reverse)) out[k] = [...set].sort();
  return out;
}

export function buildGraph(forward: Record<string, string[]>): GraphData {
  return { forward, reverse: deriveReverse(forward) };
}
