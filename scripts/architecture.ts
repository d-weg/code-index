#!/usr/bin/env -S npx tsx
// Print the folder/architecture map of a repo (zero-API).
//   npx tsx scripts/architecture.ts [root] [subpath]
import path from "node:path";
import { buildArchitecture, formatArchitecture } from "../src/folders.js";

const root = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
const sub = process.argv[3];
console.log(formatArchitecture(await buildArchitecture(root), sub));
