import { promises as fs } from "node:fs";
import path from "node:path";
import ignore, { type Ignore } from "ignore";

/** Repo-root-relative POSIX path (stable across OSes and the index format). */
export function relPosix(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join("/");
}

export function absFrom(root: string, rel: string): string {
  return path.resolve(root, rel);
}

/** Build a gitignore matcher from the root .gitignore (best-effort). */
export async function loadGitignore(root: string): Promise<Ignore> {
  const ig = ignore();
  try {
    const raw = await fs.readFile(path.join(root, ".gitignore"), "utf8");
    ig.add(raw);
  } catch {
    // no .gitignore — match nothing
  }
  // Never index our own artifacts or deps.
  ig.add([".codeindex/", "node_modules/", ".git/"]);
  return ig;
}

export function isIgnored(ig: Ignore, relPath: string): boolean {
  if (!relPath || relPath.startsWith("..")) return true;
  return ig.ignores(relPath);
}

export async function fileMtimeMs(abs: string): Promise<number> {
  const st = await fs.stat(abs);
  return st.mtimeMs;
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// Minimal glob -> RegExp (single pass): supports globstar (dir-spanning), single-star
// (within a segment), and ? (one non-slash char) over POSIX paths.
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") { re += "(?:[^/]+/)*"; i += 2; } // **/
        else { re += ".*"; i += 1; } // **
      } else { re += "[^/]*"; } // *
    } else if (c === "?") { re += "[^/]"; }
    else if (".+^${}()|[]\\".includes(c)) { re += "\\" + c; }
    else { re += c; }
  }
  return new RegExp("^" + re + "$");
}

/** Build a cached matcher: returns true if a path matches any of the globs. */
export function makeMatcher(globs: string[]): (p: string) => boolean {
  const res = globs.map(globToRegExp);
  return (p: string) => res.some((r) => r.test(p));
}
