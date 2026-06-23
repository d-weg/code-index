#!/usr/bin/env -S npx tsx
import path from "node:path";
import { buildAll, updateFiles } from "./indexer.js";

async function main() {
  const argv = process.argv.slice(2);
  let root = process.cwd();
  let update = false;
  const files: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") root = path.resolve(argv[++i]);
    else if (a === "--update") update = true;
    else files.push(a);
  }

  if (update) {
    if (files.length === 0) {
      console.error("[codeindex] --update requires one or more file paths");
      process.exit(1);
    }
    await updateFiles(root, files);
  } else {
    await buildAll(root);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
