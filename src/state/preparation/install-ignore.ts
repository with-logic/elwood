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
import { errnoCode, toError } from "../../core/errors.ts";
import { fsyncDir } from "../files.ts";

/** Remove only the path still naming the inode this operation opened. */
export function unlinkOwnedIgnore(path: string, owned: Stats): void {
  try {
    const current = lstatSync(path);
    if (current.dev === owned.dev && current.ino === owned.ino) unlinkSync(path);
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") throw error;
  }
}

/** A failed fstat/chmod/write cannot publish an empty or partial default ignore. */
export function installDefaultIgnore(gitignorePath: string): Stats | undefined {
  try {
    lstatSync(gitignorePath);
    return undefined;
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") throw error;
  }
  const staging = `${gitignorePath}.${randomUUID()}.pending`;
  const fd = openSync(
    staging,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o644,
  );
  let linked = false;
  try {
    const owned = fstatSync(fd);
    fchmodSync(fd, 0o644);
    writeFileSync(fd, "*\n");
    fsyncSync(fd);
    try {
      linkSync(staging, gitignorePath);
      linked = true;
    } catch (error) {
      if (errnoCode(error) !== "EEXIST") throw error;
    }
    unlinkOwnedIgnore(staging, owned);
    if (linked) fsyncDir(dirname(gitignorePath));
    return linked ? owned : undefined;
  } catch (error) {
    try {
      const owned = fstatSync(fd);
      if (linked) unlinkOwnedIgnore(gitignorePath, owned);
      unlinkOwnedIgnore(staging, owned);
    } catch (cleanupError) {
      throw Object.assign(toError(error), { cleanupErrorCode: errnoCode(cleanupError) });
    }
    throw error;
  } finally {
    closeSync(fd);
  }
}
