/**
 * Private temp directories for the test suites' stand-in homes (PRD §12, C-E2E-22,
 * C-E2E-23). A temp root at or inside the user's Codex home or Claude config dir would put
 * a test's state there, so creation fails closed instead.
 */

import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Creates `<tmpdir>/<prefix>XXXXXX`, refusing a temp root at or inside `userHome`, the
 * user's directory that `label` names.
 */
export function privateTempDir(prefix: string, userHome: string, label = "Codex home"): string {
  const root = tmpdir();
  const offset = relative(realOrResolved(userHome), realOrResolved(root));
  const outside = offset === ".." || offset.startsWith(`..${sep}`) || isAbsolute(offset);
  if (!outside) throw new Error(`TMPDIR is inside the user's ${label}; point it elsewhere`);
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
