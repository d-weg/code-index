import { promises as fs } from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import { inferRole } from "./package-weight.js";
import type { PackageInfo, WorkspaceInfo } from "./types.js";
import { pathExists } from "./util.js";

async function readJson<T = any>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(p, "utf8")) as T;
  } catch {
    return null;
  }
}

async function pickTsconfig(root: string, dir: string): Promise<string> {
  for (const c of ["tsconfig.json", "tsconfig.build.json", "tsconfig.app.json"]) {
    const rel = dir === "." ? c : path.posix.join(dir, c);
    if (await pathExists(path.join(root, rel))) return rel;
  }
  return "tsconfig.json"; // fall back to root config
}

/** Collect workspace package globs from package.json + pnpm-workspace.yaml. */
async function workspaceGlobs(root: string): Promise<string[]> {
  const globs: string[] = [];
  const pkg = await readJson<any>(path.join(root, "package.json"));
  if (pkg?.workspaces) {
    const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : (pkg.workspaces.packages ?? []);
    globs.push(...ws);
  }
  const pnpm = path.join(root, "pnpm-workspace.yaml");
  if (await pathExists(pnpm)) {
    const raw = await fs.readFile(pnpm, "utf8");
    let inPackages = false;
    for (const line of raw.split("\n")) {
      if (/^\s*packages:/.test(line)) {
        inPackages = true;
        continue;
      }
      if (inPackages) {
        const m = line.match(/^\s*-\s*['"]?([^'"#\n]+?)['"]?\s*$/);
        if (m) globs.push(m[1].trim());
        else if (/^\S/.test(line)) inPackages = false; // dedented to a new key
      }
    }
  }
  return [...new Set(globs.filter(Boolean))];
}

const lowerAll = (xs: unknown): string[] =>
  Array.isArray(xs) ? xs.map((x) => String(x).toLowerCase()) : [];

/**
 * Infer a package's role from its package.json dependencies + tsconfig hints (with a name/dir
 * fallback). Computed once at index time and persisted on PackageInfo, so the query path never
 * re-reads the repo. See package-weight.ts `inferRole`.
 */
async function inferPkgRole(
  root: string,
  name: string,
  dir: string,
  pkgMeta: any,
  tsconfigRel: string,
): Promise<string> {
  const deps = Object.keys({
    ...(pkgMeta?.dependencies ?? {}),
    ...(pkgMeta?.devDependencies ?? {}),
  }).map((d) => d.toLowerCase());
  const ts = await readJson<any>(path.join(root, tsconfigRel));
  return inferRole({
    name,
    dir,
    deps,
    tsLib: lowerAll(ts?.compilerOptions?.lib),
    tsTypes: lowerAll(ts?.compilerOptions?.types),
  });
}

/** Detect single-package vs monorepo and resolve each package's tsconfig. */
export async function detectWorkspace(root: string): Promise<WorkspaceInfo> {
  const globs = await workspaceGlobs(root);
  const hasTurbo = await pathExists(path.join(root, "turbo.json"));
  const hasNx = await pathExists(path.join(root, "nx.json"));
  const monorepoMarkers = globs.length > 0 || hasTurbo || hasNx;

  if (monorepoMarkers && globs.length > 0) {
    const pkgJsons = await fg(
      globs.map((g) => `${g.replace(/\/+$/, "")}/package.json`),
      { cwd: root, ignore: ["**/node_modules/**"], onlyFiles: true },
    );
    const packages: PackageInfo[] = [];
    const seen = new Set<string>();
    for (const pj of pkgJsons.sort()) {
      const dir = path.posix.dirname(pj);
      if (seen.has(dir)) continue;
      seen.add(dir);
      const meta = await readJson<any>(path.join(root, pj));
      const name = meta?.name ?? dir;
      const tsconfig = await pickTsconfig(root, dir);
      const role = await inferPkgRole(root, name, dir, meta, tsconfig);
      packages.push({ name, dir, tsconfig, role });
    }
    if (packages.length > 0) return { root, isMonorepo: true, packages };
  }

  // Single-package fallback.
  const rootPkg = await readJson<any>(path.join(root, "package.json"));
  const name = rootPkg?.name ?? "root";
  const tsconfig = await pickTsconfig(root, ".");
  const role = await inferPkgRole(root, name, ".", rootPkg, tsconfig);
  return { root, isMonorepo: false, packages: [{ name, dir: ".", tsconfig, role }] };
}

/**
 * Map a repo-relative path to its owning package (longest matching dir wins). Matches both
 * files *inside* a package dir and a path that *equals* the package dir itself (so a cwd that
 * is exactly a package root resolves to that package, not the fallback).
 */
export function packageForFile(ws: WorkspaceInfo, fileRel: string): PackageInfo {
  let best: PackageInfo | null = null;
  for (const p of ws.packages) {
    if (p.dir === ".") {
      best = best ?? p;
      continue;
    }
    const prefix = p.dir.endsWith("/") ? p.dir : p.dir + "/";
    const matches = fileRel === p.dir || fileRel.startsWith(prefix);
    if (matches && (!best || p.dir.length > best.dir.length)) best = p;
  }
  return best ?? ws.packages[0];
}
