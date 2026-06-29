#!/usr/bin/env -S npx tsx
// Self-test for re-index-on-commit (#1): after an edit commits, feeding the
// returned changedFiles to updateFiles() must leave the retrieval index
// reflecting the NEW code — no stale symbols. Builds a throwaway repo, pins the
// local potion model (offline), and asserts the index before/after a RENAME.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Project } from "ts-morph";
import { buildAll, updateFiles } from "../src/indexer.js";
import { loadConfig } from "../src/config.js";
import { loadIndex } from "../src/store.js";
import { commit, parseOps } from "../src/edit/index.js";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function symbolNames(root: string): Promise<Set<string>> {
  const config = await loadConfig(root);
  const data = await loadIndex(root, config);
  return new Set(data.symbols.map((s) => s.name));
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codeindex-reindex-"));
  try {
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { target: "ES2020", module: "ESNext", moduleResolution: "Bundler", strict: true },
        include: ["src"],
      }),
    );
    // Use the local static model so the test is offline + fast.
    await fs.writeFile(
      path.join(root, "codeindex.config.json"),
      JSON.stringify({ embeddingModel: "minishlab/potion-code-16M", indexDocs: false }),
    );
    await fs.writeFile(path.join(root, "src", "a.ts"), `export function alpha(): number {\n  return 1;\n}\n`);
    await fs.writeFile(path.join(root, "src", "b.ts"), `import { alpha } from "./a.js";\nexport const x = alpha() + 1;\n`);

    // 1. Build the index, confirm the original symbol is present.
    await buildAll(root);
    const before = await symbolNames(root);
    assert(before.has("alpha"), "index should contain 'alpha' after build");
    assert(!before.has("renamedAlpha"), "index should NOT contain 'renamedAlpha' yet");
    console.error("✓ build: index contains alpha, not renamedAlpha");

    // 2. Edit through the real commit path (writes to disk), capture changedFiles.
    const project = new Project({ tsConfigFilePath: path.join(root, "tsconfig.json") });
    const ops = parseOps("CRITICAL_REFACTOR: RENAME src/a.ts#fn_alpha TO renamedAlpha");
    const res = await commit(project, ops, { write: true, fullProjectLoaded: true, baselineDiff: true, rootDir: root });
    assert(res.ok, `commit should succeed: ${res.ok ? "" : res.feedback}`);
    assert(res.ok && res.changedFiles.length >= 2, "rename should change a.ts AND its importer b.ts");
    console.error(`✓ commit: RENAME applied, ${res.ok ? res.changedFiles.length : 0} files changed`);

    // 3. The crux: index is now STALE. Refresh only the changed files.
    const stale = await symbolNames(root);
    assert(stale.has("alpha") && !stale.has("renamedAlpha"), "index is stale until refreshed (precondition)");
    if (res.ok) await updateFiles(root, res.changedFiles);

    // 4. Index must now reflect the new code.
    const after = await symbolNames(root);
    assert(after.has("renamedAlpha"), "index should contain 'renamedAlpha' after refresh");
    assert(!after.has("alpha"), "stale 'alpha' must be gone after refresh");
    console.error("✓ refresh: index now has renamedAlpha, stale alpha gone");

    console.error("─".repeat(64));
    console.error("re-index-on-commit self-test passed");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
