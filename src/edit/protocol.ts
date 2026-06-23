import { AgentOp, ParseError } from "./types.js";

// Wire grammar the agent emits:
//
//   STRUCTURAL_EDIT: <nodeId>           STRUCTURAL_EDIT: <nodeId>
//   ACTION: SET_BODY | REPLACE_NODE     ACTION: REPLACE_TEXT
//   CODE:                               OLD:
//   <payload lines...>                  <old span>
//                                       NEW:
//                                       <new span>
//
//   CRITICAL_REFACTOR: RENAME <nodeId> TO <newName>
//
// Parser is a single linear pass over the lines — no regex backtracking, no
// per-block rescanning. Boundary lines (the two top-level keywords) terminate a
// payload; ACTION:/CODE:/OLD:/NEW: are sub-headers inside a STRUCTURAL_EDIT block.

const EDIT = "STRUCTURAL_EDIT:";
const REFACTOR = "CRITICAL_REFACTOR:";

const isBoundary = (t: string) => t.startsWith(EDIT) || t.startsWith(REFACTOR);
const after = (t: string, k: string) => t.slice(k.length).trim();

export function parseOps(stream: string): AgentOp[] {
  const lines = stream.split("\n");
  const ops: AgentOp[] = [];
  let i = 0;

  while (i < lines.length) {
    const t = lines[i].trim();

    if (t.startsWith(REFACTOR)) {
      ops.push(parseRefactor(after(t, REFACTOR), i));
      i++;
      continue;
    }

    if (t.startsWith(EDIT)) {
      const nodeId = after(t, EDIT);
      if (!nodeId) throw new ParseError(`Line ${i + 1}: STRUCTURAL_EDIT missing nodeId`);

      // ACTION line (skip blank lines between headers).
      i++;
      while (i < lines.length && lines[i].trim() === "") i++;
      const actLine = lines[i]?.trim() ?? "";
      if (!actLine.startsWith("ACTION:"))
        throw new ParseError(`Line ${i + 1}: expected ACTION: for ${nodeId}`);
      const action = after(actLine, "ACTION:").toUpperCase();

      if (action === "REPLACE_TEXT") {
        // OLD: <span> NEW: <span>  (OLD ends at the NEW: marker).
        i = expectHeader(lines, i + 1, "OLD:", nodeId);
        const old = readPayload(lines, i, (t) => t === "NEW:" || isBoundary(t));
        i = old.next;
        i = expectHeader(lines, i, "NEW:", nodeId);
        const neu = readPayload(lines, i, isBoundary);
        i = neu.next;
        ops.push({ type: "REPLACE_TEXT", nodeId, oldText: old.text, newText: neu.text });
        continue;
      }

      i = expectHeader(lines, i + 1, "CODE:", nodeId);
      const { text: payload, next } = readPayload(lines, i, isBoundary);
      i = next;
      if (action === "SET_BODY") ops.push({ type: "SET_BODY", nodeId, body: payload });
      else if (action === "REPLACE_NODE") ops.push({ type: "REPLACE_NODE", nodeId, code: payload });
      else if (action === "INSERT_BEFORE") ops.push({ type: "INSERT_BEFORE", nodeId, code: payload });
      else throw new ParseError(`Line ${i}: unknown ACTION "${action}" for ${nodeId}`);
      continue;
    }

    i++; // ignore conversational noise outside blocks
  }

  return ops;
}

/** Advance past blank lines, assert the next non-blank line equals `header`. */
function expectHeader(lines: string[], i: number, header: string, nodeId: string): number {
  while (i < lines.length && lines[i].trim() === "") i++;
  if ((lines[i]?.trim() ?? "") !== header)
    throw new ParseError(`Line ${i + 1}: expected ${header} for ${nodeId}`);
  return i + 1;
}

/** Collect lines from `i` until `stop(trimmedLine)` or EOF. Whitespace preserved. */
function readPayload(
  lines: string[],
  i: number,
  stop: (trimmed: string) => boolean,
): { text: string; next: number } {
  const start = i;
  while (i < lines.length && !stop(lines[i].trim())) i++;
  const text = lines.slice(start, i).join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
  return { text, next: i };
}

const RENAME_RE = /^RENAME\s+(\S+)\s+TO\s+([A-Za-z_$][A-Za-z0-9_$]*)$/;

function parseRefactor(rest: string, lineIdx: number): AgentOp {
  const m = RENAME_RE.exec(rest);
  if (!m) throw new ParseError(`Line ${lineIdx + 1}: malformed CRITICAL_REFACTOR "${rest}"`);
  return { type: "RENAME", nodeId: m[1], newName: m[2] };
}

// ── Bench helpers ─────────────────────────────────────────────────────────────

export function estimateTokens(s: string): number {
  const pieces = s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s.,;:(){}\[\]<>="'`+\-*/|&?!]+/)
    .filter(Boolean);
  return Math.max(1, Math.round(pieces.length * 1.3 + s.length / 8));
}
