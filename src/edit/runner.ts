import { Diagnostic, Node, Project, SourceFile, SyntaxKind } from "ts-morph";
import {
  AgentOp,
  AnchorError,
  AnchoredDiagnostic,
  CollisionError,
  CommitResult,
  GuardError,
  InsertBeforeOp,
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
}

/** Operates on a FULL, persistent ts-morph Project — never on isolated chunks. */
export class RefactorRunner {
  constructor(
    private readonly project: Project,
    private readonly opts: RunnerOptions = {},
  ) {}

  /** `path#prefix_name[~index]` → live Node. Shares the manifest id grammar. */
  resolve(nodeId: string): Node {
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
    if (matches[parsed.index]) return matches[parsed.index];
    if (matches.length === 1 && parsed.index === 0) return matches[0];
    throw new AnchorError(`${nodeId} (ambiguous: ${matches.length} matches)`);
  }

  private findSourceFile(path: string): SourceFile | undefined {
    return (
      this.project.getSourceFile(path) ??
      this.project.getSourceFiles().find((f) => f.getFilePath().endsWith(path))
    );
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
    try {
      const node = runner.resolve(ops[i].nodeId);
      if (node.getSourceFile() === sf && start >= node.getStart() && start <= node.getEnd()) {
        return { ...base, nodeId: ops[i].nodeId, opIndex: i };
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
  const runner = new RefactorRunner(project, { fullProjectLoaded });

  // Baseline needed for "newly introduced" detection (always, when repairing).
  const baseline =
    baselineDiff || repair ? new Set(gateDiagnostics(project).map(diagKey)) : null;

  const snapshot = new Map<SourceFile, string>();
  for (const sf of project.getSourceFiles()) snapshot.set(sf, sf.getFullText());
  const rollback = () => {
    for (const [sf, text] of snapshot) if (sf.getFullText() !== text) sf.replaceWithText(text);
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
    const anchored = offending.map((d) => anchorDiagnostic(d, ops, runner));
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

  const changedFiles = [...snapshot.entries()]
    .filter(([sf, text]) => sf.getFullText() !== text)
    .map(([sf]) => sf.getFilePath());

  if (write) await project.save();
  return { ok: true, appliedOps: ops.length, changedFiles, repairRounds };
}
