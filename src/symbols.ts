import {
  Node,
  type SourceFile,
  type JSDocableNode,
} from "ts-morph";
import type { SymbolEntry, SymbolKind } from "./types.js";

export interface ExtractedChunk {
  entry: SymbolEntry;
  /** Text fed to the embedder + BM25 (name + doc + truncated body). */
  text: string;
}

const BODY_CHARS = 1500;

function getDoc(node: Node): string {
  const anyNode = node as unknown as JSDocableNode;
  try {
    if (typeof anyNode.getJsDocs === "function") {
      const docs = anyNode.getJsDocs();
      if (docs.length) {
        return docs
          .map((d) => (typeof d.getDescription === "function" ? d.getDescription() : d.getText()))
          .join("\n")
          .trim();
      }
    }
  } catch {
    /* not JSDocable */
  }
  // Fallback: leading line/block comments.
  try {
    const ranges = node.getLeadingCommentRanges();
    if (ranges.length) {
      return ranges
        .map((r) => r.getText().replace(/^\/\/+|^\/\*+|\*+\/$/g, "").trim())
        .join("\n")
        .trim();
    }
  } catch {
    /* ignore */
  }
  return "";
}

function makeEntry(
  node: Node,
  name: string,
  kind: SymbolKind,
  file: string,
  pkg: string,
): { entry: SymbolEntry; text: string } {
  const startLine = node.getStartLineNumber(true); // include leading JSDoc in the range
  const endLine = node.getEndLineNumber();
  const doc = getDoc(node);
  const fullText = node.getText();
  const signature = fullText.split("\n")[0]!.trim().slice(0, 140);
  const entry: SymbolEntry = {
    id: `${file}#${name}@${startLine}`,
    name,
    kind,
    file,
    pkg,
    startLine,
    endLine,
    doc: doc || undefined,
    signature,
  };
  const text = [
    `${kind} ${name}`,
    doc,
    fullText.slice(0, BODY_CHARS),
  ]
    .filter(Boolean)
    .join("\n");
  return { entry, text };
}

/** Extract every indexable symbol from a source file into embed/BM25 chunks. */
export function extractFromSourceFile(
  sf: SourceFile,
  file: string,
  pkg: string,
): ExtractedChunk[] {
  const chunks: ExtractedChunk[] = [];

  for (const fn of sf.getFunctions()) {
    const name = fn.getName();
    if (name) chunks.push(makeEntry(fn, name, "function", file, pkg));
  }

  for (const cls of sf.getClasses()) {
    const cname = cls.getName();
    if (!cname) continue;
    chunks.push(makeEntry(cls, cname, "class", file, pkg));
    for (const m of cls.getMethods()) {
      const mname = m.getName();
      if (mname) chunks.push(makeEntry(m, `${cname}.${mname}`, "method", file, pkg));
    }
  }

  for (const iface of sf.getInterfaces()) {
    chunks.push(makeEntry(iface, iface.getName(), "interface", file, pkg));
  }

  for (const ta of sf.getTypeAliases()) {
    chunks.push(makeEntry(ta, ta.getName(), "type", file, pkg));
  }

  for (const en of sf.getEnums()) {
    chunks.push(makeEntry(en, en.getName(), "enum", file, pkg));
  }

  for (const vd of sf.getVariableDeclarations()) {
    const stmt = vd.getVariableStatement();
    if (!stmt) continue;
    const init = vd.getInitializer();
    // A function-valued top-level const carries real implementation logic even when it is
    // not individually exported — the `const createUnlock = async () => {}` … `export default
    // { createUnlock, … }` service pattern is pervasive in backend code. Index those
    // regardless of export so the implementation is retrievable; keep the export-only rule
    // for plain-value consts (config literals, singletons) to avoid flooding the index.
    const isFn = !!init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init));
    if (!isFn && !stmt.isExported()) continue;
    const name = vd.getName();
    if (!name) continue;
    const kind: SymbolKind = isFn ? "function" : "const";
    // Anchor the entry on the declaration but read doc from the statement.
    const startLine = stmt.getStartLineNumber(true);
    const endLine = vd.getEndLineNumber();
    const doc = getDoc(stmt);
    const fullText = vd.getText();
    chunks.push({
      entry: {
        id: `${file}#${name}@${startLine}`,
        name,
        kind,
        file,
        pkg,
        startLine,
        endLine,
        doc: doc || undefined,
        signature: fullText.split("\n")[0]!.trim().slice(0, 140),
      },
      text: [`${kind} ${name}`, doc, fullText.slice(0, BODY_CHARS)].filter(Boolean).join("\n"),
    });
  }

  return chunks;
}

/** A barrel is a module that is mostly `export ... from "..."` re-exports. */
export function isBarrelFile(sf: SourceFile): boolean {
  const statements = sf.getStatements();
  if (statements.length === 0) return false;
  let reexports = 0;
  let meaningful = 0;
  for (const s of statements) {
    if (Node.isExportDeclaration(s)) {
      if (s.getModuleSpecifier()) reexports++;
      continue;
    }
    if (Node.isImportDeclaration(s)) continue; // imports don't count against barrel-ness
    meaningful++;
  }
  return reexports > 0 && reexports >= Math.max(1, meaningful);
}
