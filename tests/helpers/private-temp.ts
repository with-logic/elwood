/**
 * Private temp directories for the test suites' stand-in homes (PRD §12, C-E2E-22). A
 * temp root at or inside the user's Codex home would put a test's Codex state there, so
 * creation fails closed instead.
 */

import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Creates `<tmpdir>/<prefix>XXXXXX`, refusing a temp root at or inside `userCodexHome`. */
export function privateTempDir(prefix: string, userCodexHome: string): string {
  const root = tmpdir();
  const offset = relative(realOrResolved(userCodexHome), realOrResolved(root));
  const outside = offset === ".." || offset.startsWith(`..${sep}`) || isAbsolute(offset);
  if (!outside) throw new Error("TMPDIR is inside the user's Codex home; point it elsewhere");
  return mkdtempSync(join(root, prefix));
}

/** Symlinks resolved, so `/var` and `/private/var` compare equal; a missing path as given. */
function realOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}
