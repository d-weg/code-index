// ── Agent-facing edit protocol ───────────────────────────────────────────────
// Names stay human-readable; the agent emits structural ops, never whole files.

/** Replace only the body of a function/method, preserving its signature. */
export interface SetBodyOp {
  type: "SET_BODY";
  nodeId: string;
  /** Statements only (no signature, no surrounding braces). */
  body: string;
}

/** Replace a whole declaration node — use when the signature itself changes. */
export interface ReplaceNodeOp {
  type: "REPLACE_NODE";
  nodeId: string;
  /** Full declaration source. */
  code: string;
}

/**
 * Targeted span replacement inside a node (str_replace, but anchored). `oldText`
 * only has to be unique *within the resolved node*, not the whole file — so it
 * needs far less surrounding context than a file-global str_replace. Cheapest op
 * for a small edit inside a large body (no re-emitting the whole body).
 */
export interface ReplaceTextOp {
  type: "REPLACE_TEXT";
  nodeId: string;
  oldText: string;
  newText: string;
}

/** Insert a new top-level declaration immediately before an anchored node. */
export interface InsertBeforeOp {
  type: "INSERT_BEFORE";
  nodeId: string;
  /** New declaration source (e.g. a whole function/const). */
  code: string;
}

/** Workspace-wide rename driven by the TS language service. */
export interface RenameOp {
  type: "RENAME";
  nodeId: string;
  newName: string;
}

export type AgentOp = SetBodyOp | ReplaceNodeOp | ReplaceTextOp | InsertBeforeOp | RenameOp;

// ── Results ──────────────────────────────────────────────────────────────────

/** A diagnostic attributed back to the op/node that introduced it. */
export interface AnchoredDiagnostic {
  file: string;
  line: number;
  code: number;
  message: string;
  /** The op anchor the error falls inside, if attributable. */
  nodeId?: string;
  /** Index of the op (in the original ops array) that introduced it. */
  opIndex?: number;
}

/**
 * Scoped-repair callback. Given the newly-introduced diagnostics (anchored to the
 * ops that caused them) and the round number, return patch ops that fix ONLY the
 * error — not a re-emit of the whole chunk. The rejected code is kept in place
 * (sandbox) so a small REPLACE_TEXT can target the exact location.
 */
export type RepairFn = (
  diagnostics: AnchoredDiagnostic[],
  round: number,
) => AgentOp[] | Promise<AgentOp[]>;

export interface CommitOk {
  ok: true;
  appliedOps: number;
  changedFiles: string[];
  /** How many scoped-repair rounds were needed (0 = clean first try). */
  repairRounds?: number;
}

export interface CommitFail {
  ok: false;
  feedback: string;
  failedOpIndex: number; // -1 == whole-project diagnostics gate
}

export type CommitResult = CommitOk | CommitFail;

// ── Errors (fail-closed) ──────────────────────────────────────────────────────

export class AnchorError extends Error {
  constructor(nodeId: string) {
    super(`Could not resolve AST anchor: ${nodeId}`);
    this.name = "AnchorError";
  }
}

export class GuardError extends Error {
  constructor(target: string, reason: string) {
    super(`Refusing op on ${target}: ${reason}`);
    this.name = "GuardError";
  }
}

export class CollisionError extends Error {
  constructor(newName: string) {
    super(`Rename target "${newName}" already exists in scope`);
    this.name = "CollisionError";
  }
}

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}
