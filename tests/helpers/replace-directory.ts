/**
 * Replaces a directory with a new, empty one at the same path, for tests of a launch whose
 * `cwd` was deleted and made again (PRD §5.1, C-API-61).
 */

import { mkdirSync, renameSync, rmSync } from "node:fs";

/**
 * Makes the replacement while `path` still exists, so it is a different directory (device and
 * inode) on any filesystem, even one that reuses a freed inode at once.
 */
export function replaceDirectory(path: string): void {
  const replacement = `${path}.replacement`;
  mkdirSync(replacement);
  rmSync(path, { recursive: true });
  renameSync(replacement, path);
}
