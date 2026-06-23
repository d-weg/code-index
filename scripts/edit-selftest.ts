// Self-test for the src/edit layer. Hermetic in-memory ts-morph project, no I/O.
//   npx tsx scripts/edit-selftest.ts
import { Project } from "ts-morph";
import { commit, parseOps } from "../src/edit/index.js";

function makeProject(): Project {
  const p = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { strict: true, target: 99, module: 99, moduleResolution: 100 },
  });
  p.createSourceFile(
    "src/auth/payload.ts",
    `export interface Payload { userId: string; scopes: string[]; }

export function validatePayload(p: Payload): boolean {
  return p.userId.length > 0 && p.scopes.length > 0;
}
`,
  );
  p.createSourceFile(
    "src/auth/service.ts",
    `import { Payload, validatePayload } from "./payload.js";
export function authenticate(p: Payload): string {
  if (!validatePayload(p)) throw new Error("invalid");
  return p.userId;
}
`,
  );
  return p;
}

const line = "─".repeat(64);
let failures = 0;
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failures++;
};

// A. SET_BODY preserves signature.
{
  const project = makeProject();
  const res = await commit(
    project,
    parseOps(`STRUCTURAL_EDIT: src/auth/payload.ts#fn_validatePayload
ACTION: SET_BODY
CODE:
return p.userId.trim().length > 0 && p.scopes.length > 0;`),
    { write: false },
  );
  const txt = project.getSourceFileOrThrow("src/auth/payload.ts").getFullText();
  check("SET_BODY applies, signature preserved", res.ok && txt.includes("trim()") && txt.includes(": boolean"));
}

// A2. REPLACE_TEXT swaps a span inside the body, leaves the rest untouched.
{
  const project = makeProject();
  const res = await commit(
    project,
    parseOps(`STRUCTURAL_EDIT: src/auth/payload.ts#fn_validatePayload
ACTION: REPLACE_TEXT
OLD:
p.userId.length > 0
NEW:
p.userId.trim().length > 0`),
    { write: false },
  );
  const txt = project.getSourceFileOrThrow("src/auth/payload.ts").getFullText();
  check("REPLACE_TEXT swaps span, rest intact", res.ok && txt.includes("trim()") && txt.includes("p.scopes.length > 0"));
}

// A3. REPLACE_TEXT fails closed when oldText is missing.
{
  const project = makeProject();
  const res = await commit(
    project,
    parseOps(`STRUCTURAL_EDIT: src/auth/payload.ts#fn_validatePayload
ACTION: REPLACE_TEXT
OLD:
this text is not in the node
NEW:
whatever`),
    { write: false },
  );
  check("REPLACE_TEXT fails closed on missing oldText", !res.ok);
}

// B. RENAME updates call-sites across files (full project asserted).
{
  const project = makeProject();
  const res = await commit(
    project,
    parseOps(`CRITICAL_REFACTOR: RENAME src/auth/payload.ts#fn_validatePayload TO checkPayload`),
    { write: false, fullProjectLoaded: true },
  );
  const svc = project.getSourceFileOrThrow("src/auth/service.ts").getFullText();
  check("RENAME updates cross-file call-site", res.ok && svc.includes("checkPayload") && !svc.includes("validatePayload"));
}

// C. RENAME refused without full-project assertion.
{
  const project = makeProject();
  const res = await commit(
    project,
    parseOps(`CRITICAL_REFACTOR: RENAME src/auth/payload.ts#fn_validatePayload TO checkPayload`),
    { write: false },
  );
  check("RENAME refused when project not fully loaded", !res.ok);
}

// D. Diagnostics gate + rollback on a type-breaking edit.
{
  const project = makeProject();
  const before = project.getSourceFileOrThrow("src/auth/payload.ts").getFullText();
  const res = await commit(
    project,
    parseOps(`STRUCTURAL_EDIT: src/auth/payload.ts#fn_validatePayload
ACTION: SET_BODY
CODE:
return p.userId;`),
    { write: false },
  );
  const after = project.getSourceFileOrThrow("src/auth/payload.ts").getFullText();
  check("bad edit rejected by diagnostics gate + rolled back", !res.ok && before === after);
}

console.log(line);
console.log(failures === 0 ? "all edit self-tests passed" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
