import { Node, SourceFile, SyntaxKind } from "ts-morph";

// nodeId = `relativePath#<prefix>_<name>[~index]`
//   fn_foo            FunctionDeclaration
//   cls_Foo           ClassDeclaration
//   iface_Foo         InterfaceDeclaration
//   enum_Foo          EnumDeclaration
//   type_Foo          TypeAliasDeclaration
//   var_foo           VariableDeclaration (top-level)
//   meth_Foo.bar      MethodDeclaration   (Class.method)
// `~index` disambiguates same-named/same-kind nodes (overloads, nested scopes).

const PREFIX_TO_KIND: Record<string, SyntaxKind> = {
  fn: SyntaxKind.FunctionDeclaration,
  cls: SyntaxKind.ClassDeclaration,
  iface: SyntaxKind.InterfaceDeclaration,
  enum: SyntaxKind.EnumDeclaration,
  type: SyntaxKind.TypeAliasDeclaration,
  var: SyntaxKind.VariableDeclaration,
  meth: SyntaxKind.MethodDeclaration,
};

const KIND_TO_PREFIX = new Map<SyntaxKind, string>(
  Object.entries(PREFIX_TO_KIND).map(([p, k]) => [k, p]),
);

function localName(node: Node): string | undefined {
  if (Node.isMethodDeclaration(node)) {
    const cls = node.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
    const clsName = cls?.getName();
    const m = node.getName();
    return clsName && m ? `${clsName}.${m}` : undefined;
  }
  const named = node as { getName?: () => string | undefined };
  return typeof named.getName === "function" ? named.getName() : undefined;
}

/** Deterministic id for one node. `index` distinguishes prior same-id siblings. */
export function nodeIdFor(node: Node, relPath: string, index = 0): string | undefined {
  const prefix = KIND_TO_PREFIX.get(node.getKind());
  const name = localName(node);
  if (!prefix || !name) return undefined;
  const suffix = index > 0 ? `~${index}` : "";
  return `${relPath}#${prefix}_${name}${suffix}`;
}

/** Generate ids for every indexable node in a file (manifest compilation). */
export function indexSourceFile(sf: SourceFile, relPath: string): Map<string, Node> {
  const out = new Map<string, Node>();
  const seen = new Map<string, number>(); // base id -> count, for ~index
  for (const node of sf.getDescendants()) {
    if (!KIND_TO_PREFIX.has(node.getKind())) continue;
    const base = nodeIdFor(node, relPath, 0);
    if (!base) continue;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.set(nodeIdFor(node, relPath, n)!, node);
  }
  return out;
}

export interface ParsedNodeId {
  path: string;
  prefix: string;
  kind: SyntaxKind;
  name: string; // for methods: "Class.method"
  index: number;
}

export function parseNodeId(nodeId: string): ParsedNodeId | undefined {
  const hash = nodeId.indexOf("#");
  if (hash === -1) return undefined;
  const path = nodeId.slice(0, hash);
  let locator = nodeId.slice(hash + 1);

  let index = 0;
  const tilde = locator.lastIndexOf("~");
  if (tilde !== -1) {
    const n = Number(locator.slice(tilde + 1));
    if (Number.isInteger(n)) {
      index = n;
      locator = locator.slice(0, tilde);
    }
  }

  const us = locator.indexOf("_");
  if (us === -1) return undefined;
  const prefix = locator.slice(0, us);
  const name = locator.slice(us + 1);
  const kind = PREFIX_TO_KIND[prefix];
  if (kind === undefined || !name) return undefined;

  return { path, prefix, kind, name, index };
}

export { PREFIX_TO_KIND };
