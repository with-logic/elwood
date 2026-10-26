/**
 * Makes a state root without ever making the session's working directory. The root is made only
 * while `cwd` exists; one at or under `cwd` is made only below it, one directory at a time, and
 * a root elsewhere gets its missing parents. Implements PRD §8.1 and C-STATE-14.
 */

import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { withRealAncestor } from "./canonical-path.ts";
import {
  makeStateDirectory,
  PRIVATE_STATE_MODE,
  prepareStateDirectory,
  type StateDirectoryMode,
} from "./directories.ts";

/** Makes the state root `root` with `mode` for a session in `cwd`. */
export function makeStateRoot(root: string, mode: StateDirectoryMode, cwd: string): void {
  // The root first: while `cwd` exists, its real path, spelled as on disk, leads the root's too,
  // so the two compare exactly however the caller spelled them.
  const target = withRealAncestor(root, realpathSync.native);
  // A missing `cwd` fails here with ENOENT, before anything is made, wherever the root is.
  const project = realpathSync.native(cwd);
  const names = namesBelow(project, target);
  if (names === undefined) {
    prepareStateDirectory(root, mode, "with-parents");
    return;
  }
  // Each directory is made inside its parent, so a `cwd` removed meanwhile fails the next one
  // with ENOENT instead of coming back.
  let current = project;
  for (const name of names.slice(0, -1)) {
    current = join(current, name);
    makeStateDirectory(current, PRIVATE_STATE_MODE, "inside-parent");
  }
  prepareStateDirectory(root, mode, names.length === 0 ? "must-exist" : "inside-parent");
}

/** The names leading from `project` down to `path`, or `undefined` when it is not under it. */
function namesBelow(project: string, path: string): readonly string[] | undefined {
  const below = relative(project, path);
  if (below === "") return [];
  if (below === ".." || below.startsWith(`..${sep}`) || isAbsolute(below)) return undefined;
  return below.split(sep);
}
