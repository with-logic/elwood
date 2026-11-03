/** Publish a fully written ignore file without overwriting another writer (PRD §8.1, C-STATE-11). */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { elwoodError, errnoCode, toError } from "../../core/errors.ts";
import { fsyncDir } from "../files.ts";
import { stateCleanupFailure } from "../setup-failure.ts";

/** Remove only the path still naming the inode this operation opened. */
export function unlinkOwnedIgnore(path: string, owned: Stats): void {
  try {
    const current = lstatSync(path);
    if (current.dev === owned.dev && current.ino === owned.ino) unlinkSync(path);
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") throw error;
  }
}

/** Validate and durably accept an existing ignore without changing its contents. */
function existingIgnore(path: string): boolean {
  try {
    const info = lstatSync(path);
    if (!info.isFile())
      throw elwoodError("state_corrupt", `Default ignore must be a regular file: ${path}`);
    fsyncDir(dirname(path));
    return true;
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") throw error;
    return false;
  }
}

/** Publish complete contents; a published ignore may already belong to another start. */
export function installDefaultIgnore(gitignorePath: string): Stats | undefined {
  if (existingIgnore(gitignorePath)) return undefined;
  const staging = `${gitignorePath}.${randomUUID()}.pending`;
  const fd = openSync(
    staging,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o644,
  );
  let installed: Stats | undefined;
  let failure: Error | undefined;
  try {
    const owned = fstatSync(fd);
    fchmodSync(fd, 0o644);
    writeFileSync(fd, "*\n");
    fsyncSync(fd);
    try {
      linkSync(staging, gitignorePath);
      installed = owned;
    } catch (error) {
      if (errnoCode(error) !== "EEXIST" || !existingIgnore(gitignorePath)) throw error;
    }
    unlinkOwnedIgnore(staging, owned);
    if (installed !== undefined) fsyncDir(dirname(gitignorePath));
  } catch (error) {
    failure = toError(error);
    try {
      unlinkOwnedIgnore(staging, fstatSync(fd));
    } catch (cleanupError) {
      failure = toError(stateCleanupFailure(failure, errnoCode(cleanupError)));
    }
  } finally {
    try {
      closeSync(fd);
    } catch (closeError) {
      failure =
        failure === undefined
          ? toError(closeError)
          : toError(stateCleanupFailure(failure, errnoCode(closeError)));
    }
  }
  if (failure !== undefined) throw failure;
  return installed;
}
