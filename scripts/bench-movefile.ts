// MOVE_FILE A/B: one directive vs manually editing every importer's path.
// The file is moved AND all importers are rewritten by ts-morph, gated by the
// type-checker. Executed in-memory; token = chars/4. The win grows with importer
// count (the directive stays one line).
import { Project } from "ts-morph";
import { commit, parseOps } from "../src/edit/index.js";

const tok = (s: string) => Math.round(s.length / 4);
const STR_REPLACE_OVERHEAD = 6; // tool-call scaffolding per edit
const IMPORTERS = ["a", "b", "c", "d", "e", "f", "g", "h"];

function makeProject(): Project {
  const p = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { strict: true, target: 99, module: 99, moduleResolution: 100 },
  });
  p.createSourceFile("src/utils.ts", "export const helper = (x: number) => x + 1;\n");
  IMPORTERS.forEach((n, i) =>
    p.createSourceFile(`src/${n}.ts`, `import { helper } from "./utils.js";\nexport const ${n} = helper(${i});\n`),
  );
  return p;
}

async function main() {
  // Baseline: a normal agent edits each importer's import line.
  const oldLine = `import { helper } from "./utils.js";`;
  const newLine = `import { helper } from "./lib/utils.js";`;
  const baselineOut = IMPORTERS.length * (tok(oldLine) + tok(newLine) + STR_REPLACE_OVERHEAD);

  // Protocol: one directive; the runner moves the file + rewrites every importer.
  const directive = "MOVE_FILE: src/utils.ts TO src/lib/utils.ts";
  const moveOut = tok(directive);

  // Execute through the gate.
  const project = makeProject();
  const res = await commit(project, parseOps(directive), { write: false, rootDir: "/" });
  const importerFixed = project
    .getSourceFileOrThrow("src/a.ts")
    .getFullText()
    .includes("./lib/utils");

  console.log(`=== MOVE_FILE — move a file imported by ${IMPORTERS.length} files ===`);
  console.log(`  baseline (edit each importer): ${String(baselineOut).padStart(4)} tok  (${IMPORTERS.length} str_replace)`);
  console.log(`  protocol (one directive):      ${String(moveOut).padStart(4)} tok`);
  console.log(`  reduction: ${(((baselineOut - moveOut) / baselineOut) * 100).toFixed(0)}%  (${(baselineOut / moveOut).toFixed(0)}× fewer)`);
  console.log(`  executed: gate ${res.ok ? "PASS ✓" : "FAIL ✗"}, importers rewritten: ${importerFixed ? "✓" : "✗"}`);
  console.log(`\n  The directive stays one line regardless of importer count; the baseline scales with it.`);
}

main();
