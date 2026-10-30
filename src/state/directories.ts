/** No-follow state directory creation and ownership checks (PRD §8.1/§8.2). */
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { elwoodError, errnoCode } from "../core/errors.ts";

/** Reject planted ancestors too, while allowing root-owned OS aliases such as /tmp. */
export function assertStatePath(path: string): void {
  const leaf = resolve(path);
  let current = leaf;
  while (true) {
    assertSafeEntry(current, current === leaf);
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

/** A missing entry passes; a symlink fails, unless it is an ancestor that root owns. */
function assertSafeEntry(path: string, isLeaf: boolean): void {
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink() && (isLeaf || info.uid !== 0)) {
      throw elwoodError("state_corrupt", `State path must not follow a symlink: ${path}`);
    }
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") throw error;
  }
}

/** A private state directory: only its owner may enter it. */
export const PRIVATE_STATE_MODE = 0o700;
/** A shared state directory, such as the default `.elwood/`, readable by local tooling. */
export const SHARED_STATE_MODE = 0o755;
/** The modes a state directory may have. */
export type StateDirectoryMode = typeof PRIVATE_STATE_MODE | typeof SHARED_STATE_MODE;

/**
 * Whether a state directory may be made: with its missing parents, only itself inside an
 * existing parent, or not at all, when it must exist already. Under a state root, a missing
 * parent means the root, or the project it lives in, was removed, and making it again would
 * recreate that project (C-STATE-14).
 */
export type StateDirectoryPolicy = "with-parents" | "inside-parent" | "must-exist";

/**
 * Makes the state directory `path` as `policy` allows, once `assertStatePath` finds no unsafe
 * symlink leading to it: `path` itself must not be one, and an ancestor may be only when root
 * owns it, as with `/tmp`. It does not check who owns an existing directory or change its mode;
 * `prepareStateDirectory` does both.
 */
export function makeStateDirectory(
  path: string,
  mode: StateDirectoryMode,
  policy: StateDirectoryPolicy,
): void {
  assertStatePath(path);
  makeAs[policy](path, mode);
}

/**
 * Makes `path` inside its existing parent, an ancestry the caller has already checked, so only
 * `path` itself is checked not to be a symlink.
 */
export function makeStateDirectoryBelow(path: string, mode: StateDirectoryMode): void {
  assertSafeEntry(path, true);
  makeInsideParent(path, mode);
}

/**
 * Prepares the state directory `path`: makes it as `policy` allows, then checks that it is a
 * directory the current user owns and gives it `mode`.
 */
export function prepareStateDirectory(
  path: string,
  mode: StateDirectoryMode,
  policy: StateDirectoryPolicy,
): void {
  makeStateDirectory(path, mode, policy);
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isDirectory() || info.uid !== process.getuid?.()) {
      throw elwoodError(
        "state_corrupt",
        `State directory must be owned by the current user: ${path}`,
      );
    }
    fchmodSync(fd, mode);
  } finally {
    closeSync(fd);
  }
}

/** How each policy makes a directory; the type makes every policy name one. */
const makeAs: Readonly<
  Record<StateDirectoryPolicy, (path: string, mode: StateDirectoryMode) => void>
> = {
  "with-parents": (path, mode) => mkdirSync(path, { recursive: true, mode }),
  "inside-parent": makeInsideParent,
  "must-exist": () => {
    // Never made: the open below fails with ENOENT when it is missing.
  },
};

/** Makes `path` inside its existing parent; an existing directory is fine, a missing parent not. */
function makeInsideParent(path: string, mode: StateDirectoryMode): void {
  try {
    mkdirSync(path, { mode });
  } catch (error) {
    if (errnoCode(error) !== "EEXIST") throw error;
  }
}
