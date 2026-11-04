/**
 * Makes a state root without ever making the session's working directory. The root is made only
 * while `cwd` exists; one at or under `cwd` is made only below it, one directory at a time, and
 * a root elsewhere gets its missing parents, which are taken back if `cwd` is gone once they are
 * made. Implements PRD §8.1 and C-STATE-14.
 */

import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { errnoCode } from "../core/errors.ts";
import { withRealAncestor } from "./canonical-path.ts";
import {
  assertStatePath,
  makeStateDirectoryBelow,
  PRIVATE_STATE_MODE,
  prepareStateDirectory,
  type StateDirectoryMode,
  type StateDirectoryPolicy,
} from "./directories.ts";
import {
  CreatedStateDirectories,
  type StateDirectoryCreationObserver,
} from "./preparation/created-directories.ts";
import { stateCleanupFailure } from "./setup-failure.ts";

/** What makes the root itself once its parents are in place. */
export type MakeRootDirectory = (
  path: string,
  mode: StateDirectoryMode,
  policy: StateDirectoryPolicy,
  onDirectoryCreated?: StateDirectoryCreationObserver,
) => void;

/**
 * Makes the state root `root` with `mode` for a session in `cwd`, the root itself through
 * `make`, which by default also checks it and gives it `mode`.
 */
export function makeStateRoot(
  root: string,
  mode: StateDirectoryMode,
  cwd: string,
  make: MakeRootDirectory = prepareStateDirectory,
  onDirectoryCreated?: StateDirectoryCreationObserver,
): void {
  // The root first: while `cwd` exists, its real path, spelled as on disk, leads the root's too,
  // so the two compare exactly however the caller spelled them.
  const target = withRealAncestor(root, realpathSync.native);
  // A missing `cwd` fails here with ENOENT, before anything is made, wherever the root is.
  const project = realpathSync.native(cwd);
  const names = namesBelow(project, target);
  if (names === undefined) {
    make(root, mode, "with-parents", onDirectoryCreated);
    return;
  }
  // Each directory is made inside its parent, so a `cwd` removed meanwhile fails the next one
  // with ENOENT instead of coming back. Their path is checked for symlinks once, then each one
  // only itself: checking every ancestor again at each level made a deep root quadratic.
  let current = project;
  const parents = names.slice(0, -1);
  assertStatePath(join(project, ...parents));
  for (const name of parents) {
    current = join(current, name);
    makeStateDirectoryBelow(current, PRIVATE_STATE_MODE, onDirectoryCreated);
  }
  make(root, mode, names.length === 0 ? "must-exist" : "inside-parent", onDirectoryCreated);
}

/** The names leading from `project` down to `path`, or `undefined` when it is not under it. */
function namesBelow(project: string, path: string): readonly string[] | undefined {
  const below = relative(project, path);
  if (below === "") return [];
  if (below === ".." || below.startsWith(`..${sep}`) || isAbsolute(below)) return undefined;
  return below.split(sep);
}

/**
 * How many times `makeTree` runs while `cwd` stays: another start's undo can remove a directory
 * this one found already made, so making the next one inside it fails with ENOENT.
 */
const maxStateTreeAttempts = 3;

/**
 * Runs `makeTree`, recording its successful directory creations for a session in `cwd`,
 * then requires `cwd` to exist still. A `cwd` removed meanwhile fails with ENOENT, and the
 * rollback removes only still-matching, owned, empty directories, deepest first (C-STATE-14).
 * Replaced or unverifiable entries are preserved. Nonempty directories, including those
 * another start has populated, stay in place; entries already gone need no cleanup.
 */
export function makeStateTree(
  cwd: string,
  makeTree: (onDirectoryCreated: StateDirectoryCreationObserver) => void,
): void {
  const made = new CreatedStateDirectories();
  for (let attempt = 1; ; attempt += 1) {
    try {
      makeTree(made.record);
      break;
    } catch (error) {
      const retry = errnoCode(error) === "ENOENT" && existsSync(cwd);
      if (!retry || attempt === maxStateTreeAttempts) throw error;
    }
  }
  try {
    realpathSync.native(cwd);
  } catch (error) {
    const cleanupErrorCode = made.remove();
    throw stateCleanupFailure(error, cleanupErrorCode);
  }
}
