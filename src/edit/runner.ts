import path from "node:path";
import { Diagnostic, Node, Project, SourceFile, SyntaxKind } from "ts-morph";
import {
  AgentOp,
  AnchorError,
  AnchoredDiagnostic,
  CollisionError,
  CommitResult,
  CreateFileOp,
  DeleteFileOp,
  GuardError,
  InsertBeforeOp,
  MoveFileOp,
  RenameOp,
  RepairFn,
  ReplaceNodeOp,
  ReplaceTextOp,
  SetBodyOp,
} from "./types.js";
import { collides, isProjectOwned, isRenameable } from "./guards.js";
import { parseNodeId } from "./nodeId.js";

export interface RunnerOptions {
  /**
   * Assert the Project was loaded from tsconfig with the WHOLE source graph.
   * Required for RENAME: ts-morph only rewrites call-sites in loaded files, so a
   * lazy/partial project makes rename silently corrupt the codebase. Verified.
   */
  fullProjectLoaded?: boolean;
  /** Repo root for resolving relative file-op paths (MOVE_FILE/CREATE_FILE/...). */
  rootDir?: string;
}

/** Operates on a FULL, persistent ts-morph Project — never on isolated chunks. */
export class RefactorRunner {
  constructor(
    private readonly project: Project,
    private readonly opts: RunnerOptions = {},
  ) {}

  /**
   * Optional resolve cache. Only safe during a READ-ONLY window (e.g. attributing
   * diagnostics to ops): nodes are forgotten/repathed by edits, so the cache must
   * be cleared before any further `apply`. Off by default.
   */
  private resolveCache: Map<string, Node> | null = null;
  beginResolveCache(): void {
    this.resolveCache = new Map();
  }
  endResolveCache(): void {
    this.resolveCache = null;
  }
  private cacheNode(id: string, n: Node): Node {
    this.resolveCache?.set(id, n);
    return n;
  }

  /** `path#prefix_name[~index]` → live Node. Shares the manifest id grammar. */
  resolve(nodeId: string): Node {
    const cached = this.resolveCache?.get(nodeId);
    if (cached) return cached;

    const parsed = parseNodeId(nodeId);
    if (!parsed) throw new AnchorError(nodeId);

    const sf = this.findSourceFile(parsed.path);
    if (!sf) throw new AnchorError(nodeId);

    const matches = sf.getDescendantsOfKind(parsed.kind).filter((n) => {
      if (parsed.prefix === "meth") {
        const cls = n.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
        const clsName = cls?.getName();
        const mName = (n as { getName?: () => string }).getName?.();
        return `${clsName}.${mName}` === parsed.name;
      }
      return (n as { getName?: () => string }).getName?.() === parsed.name;
    });

    if (matches.length === 0) throw new AnchorError(nodeId);
    if (matches[parsed.index]) return this.cacheNode(nodeId, matches[parsed.index]);
    if (matches.length === 1 && parsed.index === 0) return this.cacheNode(nodeId, matches[0]);
    throw new AnchorError(`${nodeId} (ambiguous: ${matches.length} matches)`);
  }

  /**
   * Resolve a file by repo-relative or absolute path. Exact lookup first, then
   * (for relative paths) joined against rootDir, then a path-BOUNDARY suffix match
   * with an ambiguity guard — never a bare `endsWith`, which would silently pick
   * the wrong `foo.ts` when several exist.
   */
  private findSourceFile(p: string): SourceFile | undefined {
    const direct = this.project.getSourceFile(p);
    if (direct) return direct;
    if (this.opts.rootDir && !path.isAbsolute(p)) {
      const byAbs = this.project.getSourceFile(path.join(this.opts.rootDir, p));
      if (byAbs) return byAbs;
    }
    const needle = p.startsWith("/") ? p : "/" + p;
    const matches = this.project.getSourceFiles().filter((f) => f.getFilePath().endsWith(needle));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1)
      throw new AnchorError(`${p} (ambiguous: ${matches.length} files match this path)`);
    return undefined;
  }

  applySetBody(op: SetBodyOp): void {
    const node = this.resolve(op.nodeId);
    const fn = node as { setBodyText?: (t: string) => void };
    if (typeof fn.setBodyText !== "function")
      throw new GuardError(op.nodeId, `kind has no body to set (${node.getKindName()})`);
    fn.setBodyText(op.body);
  }

  applyReplaceNode(op: ReplaceNodeOp): void {
    this.resolve(op.nodeId).replaceWithText(op.code);
  }

  applyReplaceText(op: ReplaceTextOp): void {
    const node = this.resolve(op.nodeId);
    const text = node.getText();
    const first = text.indexOf(op.oldText);
    if (first === -1) throw new GuardError(op.nodeId, "REPLACE_TEXT oldText not found in node");
    if (text.indexOf(op.oldText, first + 1) !== -1)
      throw new GuardError(op.nodeId, "REPLACE_TEXT oldText not unique within node; add context");
    node.replaceWithText(text.slice(0, first) + op.newText + text.slice(first + op.oldText.length));
  }

  applyInsertBefore(op: InsertBeforeOp): void {
    const node = this.resolve(op.nodeId);
    const sf = node.getSourceFile();
    // Walk up to the top-level statement that contains the anchor.
    let stmt: Node = node;
    while (stmt.getParent() && stmt.getParentOrThrow().getKind() !== SyntaxKind.SourceFile) {
      stmt = stmt.getParentOrThrow();
    }
    const idx = sf.getStatements().findIndex((s) => s === stmt);
    if (idx < 0) throw new GuardError(op.nodeId, "anchor is not a top-level statement");
    sf.insertStatements(idx, op.code);
  }

  applyRename(op: RenameOp): void {
    if (!this.opts.fullProjectLoaded)
      throw new GuardError(
        op.nodeId,
        "RENAME requires the full project loaded (set fullProjectLoaded); partial load misses call-sites",
      );
    const decl = this.resolve(op.nodeId);
    const sym = decl.getSymbol();
    if (!isProjectOwned(sym))
      throw new GuardError(op.nodeId, "declaration is outside the project (library/ambient)");
    if (collides(decl, op.newName)) throw new CollisionError(op.newName);
    if (!isRenameable(decl))
      throw new GuardError(op.nodeId, `node kind ${decl.getKindName()} is not renameable`);
    decl.rename(op.newName);
  }

  private absPath(p: string): string {
    if (path.isAbsolute(p)) return p;
    if (!this.opts.rootDir) throw new GuardError(p, "file ops need rootDir to resolve relative paths");
    return path.join(this.opts.rootDir, p);
  }

  /** Move/rename a file — ts-morph rewrites every import specifier referencing it. */
  applyMoveFile(op: MoveFileOp): void {
    const sf = this.findSourceFile(op.from);
    if (!sf) throw new AnchorError(`MOVE_FILE source not found: ${op.from}`);
    sf.move(this.absPath(op.to));
  }

  applyCreateFile(op: CreateFileOp): void {
    const abs = this.absPath(op.path);
    if (this.project.getSourceFile(abs) || this.findSourceFile(op.path))
      throw new GuardError(op.path, "CREATE_FILE: a file at that path already exists");
    this.project.createSourceFile(abs, op.code);
  }

  applyDeleteFile(op: DeleteFileOp): void {
    const sf = this.findSourceFile(op.path);
    if (!sf) throw new AnchorError(`DELETE_FILE not found: ${op.path}`);
    sf.delete(); // gate rejects if anything still imports it
  }

  apply(op: AgentOp): void {
    switch (op.type) {
      case "SET_BODY":
        return this.applySetBody(op);
      case "REPLACE_NODE":
        return this.applyReplaceNode(op);
      case "REPLACE_TEXT":
        return this.applyReplaceText(op);
      case "INSERT_BEFORE":
        return this.applyInsertBefore(op);
      case "RENAME":
        return this.applyRename(op);
      case "MOVE_FILE":
        return this.applyMoveFile(op);
      case "CREATE_FILE":
        return this.applyCreateFile(op);
      case "DELETE_FILE":
        return this.applyDeleteFile(op);
    }
  }
}

/**
 * Correctness diagnostics for the gate: syntactic + semantic only. We avoid
 * getPreEmitDiagnostics() because its declaration-emit path crashes on real
 * composite/declaration tsconfigs (and .d.ts emit isn't a correctness signal).
 */
function gateDiagnostics(project: Project): Diagnostic[] {
  const program = project.getProgram();
  return [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()];
}

/** Stable key for a diagnostic, robust to line shifts (no line number). */
function diagKey(d: Diagnostic): string {
  const mt = d.getMessageText();
  const msg = typeof mt === "string" ? mt : mt.getMessageText();
  return `${d.getSourceFile()?.getFilePath() ?? "?"}::${d.getCode()}::${msg}`;
}

function flatMessage(d: Diagnostic): string {
  const mt = d.getMessageText();
  return typeof mt === "string" ? mt : mt.getMessageText();
}

/** Attribute a diagnostic to the op whose anchored node contains its position. */
function anchorDiagnostic(
  d: Diagnostic,
  ops: AgentOp[],
  runner: RefactorRunner,
): AnchoredDiagnostic {
  const sf = d.getSourceFile();
  const base: AnchoredDiagnostic = {
    file: sf?.getFilePath() ?? "?",
    line: d.getLineNumber() ?? 0,
    code: d.getCode(),
    message: flatMessage(d),
  };
  const start = d.getStart();
  if (!sf || start == null) return base;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (!("nodeId" in op)) continue; // file ops have no node anchor
    try {
      const node = runner.resolve(op.nodeId);
      if (node.getSourceFile() === sf && start >= node.getStart() && start <= node.getEnd()) {
        return { ...base, nodeId: op.nodeId, opIndex: i };
      }
    } catch {
      /* op may not resolve (e.g. after rename) — skip attribution */
    }
  }
  return base;
}

/**
 * Atomic commit: apply → diagnostics gate → disk write, else roll back.
 *
 * `baselineDiff` makes the gate fail only on **newly introduced** diagnostics —
 * required on real repos that already have pre-existing errors (snapshot the
 * baseline before applying, compare after). Keyed without line numbers so an
 * insert that shifts lines doesn't falsely flag pre-existing errors below it.
 */
export async function commit(
  project: Project,
  ops: AgentOp[],
  {
    write = true,
    fullProjectLoaded = false,
    rootDir,
    baselineDiff = false,
    repair,
    maxRepairRounds = 2,
  }: {
    write?: boolean;
    baselineDiff?: boolean;
    /** If set, attempt scoped repair instead of failing on new diagnostics. */
    repair?: RepairFn;
    maxRepairRounds?: number;
  } & RunnerOptions = {},
): Promise<CommitResult> {
  const runner = new RefactorRunner(project, { fullProjectLoaded, rootDir });

  // Baseline needed for "newly introduced" detection (always, when repairing).
  const baseline =
    baselineDiff || repair ? new Set(gateDiagnostics(project).map(diagKey)) : null;

  // Path-keyed snapshot so rollback survives file ops (move/delete/create), where
  // SourceFile nodes get forgotten or repathed.
  const snapshot = new Map<string, string>();
  for (const sf of project.getSourceFiles()) snapshot.set(sf.getFilePath(), sf.getFullText());
  const rollback = () => {
    // Drop anything created/moved-to since the snapshot.
    for (const sf of [...project.getSourceFiles()]) {
      if (!snapshot.has(sf.getFilePath())) sf.delete();
    }
    // Restore originals: re-create moved/deleted files, fix edited ones.
    for (const [p, text] of snapshot) {
      const existing = project.getSourceFile(p);
      if (existing) {
        if (existing.getFullText() !== text) existing.replaceWithText(text);
      } else {
        project.createSourceFile(p, text, { overwrite: true });
      }
    }
  };

  for (let i = 0; i < ops.length; i++) {
    try {
      runner.apply(ops[i]);
    } catch (e) {
      rollback();
      return { ok: false, failedOpIndex: i, feedback: `Op #${i} (${ops[i].type}) failed: ${(e as Error).message}` };
    }
  }

  const newDiags = () => {
    const all = gateDiagnostics(project);
    return baseline ? all.filter((d) => !baseline.has(diagKey(d))) : all;
  };

  // Scoped-repair loop: keep the (failing) code in place and patch only the error
  // location, attributing each diagnostic to the op that introduced it. Passing
  // ops are never rolled back — only the offending spans get patched.
  let repairRounds = 0;
  let offending = newDiags();
  while (offending.length > 0 && repair && repairRounds < maxRepairRounds) {
    // Attribution is read-only: cache resolves so we don't re-walk the AST for
    // every (diagnostic × op) pair. Cleared before any patch op mutates the tree.
    runner.beginResolveCache();
    const anchored = offending.map((d) => anchorDiagnostic(d, ops, runner));
    runner.endResolveCache();
    const patchOps = await repair(anchored, repairRounds);
    if (patchOps.length === 0) break;
    try {
      for (const op of patchOps) runner.apply(op);
    } catch {
      break; // a malformed patch — stop and fail below
    }
    repairRounds++;
    offending = newDiags();
  }

  if (offending.length > 0) {
    const feedback = project.formatDiagnosticsWithColorAndContext(offending);
    rollback();
    return { ok: false, failedOpIndex: -1, feedback };
  }

  // changedFiles = edited + created/moved-to + deleted/moved-from.
  const now = new Map<string, string>(
    project.getSourceFiles().map((sf) => [sf.getFilePath() as string, sf.getFullText()]),
  );
  const changedFiles: string[] = [];
  for (const [p, text] of snapshot) {
    if (!now.has(p) || now.get(p) !== text) changedFiles.push(p);
  }
  for (const p of now.keys()) if (!snapshot.has(p)) changedFiles.push(p);

  if (write) await project.save();
  return { ok: true, appliedOps: ops.length, changedFiles, repairRounds };
}
