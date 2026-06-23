// AST-anchored edit operations: the apply/refactor layer that consumes the
// retrieval manifest's nodeId anchors and mutates the workspace via ts-morph.
//
//   parseOps(agentOutput)  ->  AgentOp[]
//   commit(project, ops, { fullProjectLoaded })  ->  CommitResult
//
// Retrieval (BM25 + dense + import-graph) is unchanged; this is downstream of it.

export type {
  AgentOp,
  SetBodyOp,
  ReplaceNodeOp,
  ReplaceTextOp,
  InsertBeforeOp,
  RenameOp,
  CommitResult,
  CommitOk,
  CommitFail,
  AnchoredDiagnostic,
  RepairFn,
} from "./types.js";
export { AnchorError, GuardError, CollisionError, ParseError } from "./types.js";

export { parseOps, estimateTokens } from "./protocol.js";
export { nodeIdFor, indexSourceFile, parseNodeId } from "./nodeId.js";
export { RefactorRunner, commit } from "./runner.js";
export { isProjectOwned, collides, isRenameable } from "./guards.js";
