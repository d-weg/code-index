import { Node, Symbol as MorphSymbol, Project } from "ts-morph";

/**
 * Provenance test from the design §2: a symbol may only be mutated if *every*
 * one of its declarations lives inside the user's own source tree. Anything
 * resolving into node_modules or an ambient `.d.ts` is off-limits — this
 * single check subsumes the keyword/global/library blocklists.
 */
export function isProjectOwned(sym: MorphSymbol | undefined): boolean {
  const decls = sym?.getDeclarations() ?? [];
  if (decls.length === 0) return false;
  return decls.every((d) => {
    const f = d.getSourceFile().getFilePath();
    return !f.includes("node_modules") && !f.endsWith(".d.ts");
  });
}

/**
 * Would `newName` collide with an existing identifier visible from `at`?
 * Uses the language service's scope view rather than a naive text scan, so it
 * respects shadowing and block scope.
 */
export function collides(at: Node, newName: string): boolean {
  const checker = at.getProject().getTypeChecker();
  const symbols = checker.getSymbolsInScope(
    at,
    // Value | Type | Namespace — broad on purpose; a rename collision in any
    // of these meaning-spaces is unsafe.
    /* SymbolFlags.Value */ 111551 | /* Type */ 788968 | /* Namespace */ 1920,
  );
  return symbols.some((s) => s.getName() === newName);
}

/** True if a node supports `.rename()`. */
export function isRenameable(
  node: Node,
): node is Node & { rename: (name: string) => void } {
  return typeof (node as { rename?: unknown }).rename === "function";
}

export { Project };
