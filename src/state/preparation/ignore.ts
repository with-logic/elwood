/** Own only a newly created default ignore file; failed starts preserve other trees (C-STATE-14). */

import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { errnoCode } from "../../core/errors.ts";

/** Create without overwriting another writer, and return an identity-checked undo. */
export function createDefaultIgnore(
  path: string,
  sessions: string,
  id: string | undefined,
): (() => void) | undefined {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o644,
    );
  } catch (error) {
    if (errnoCode(error) === "EEXIST") return undefined;
    throw error;
  }
  let owned: ReturnType<typeof fstatSync>;
  try {
    owned = fstatSync(fd);
    fchmodSync(fd, 0o644);
    writeFileSync(fd, "*\n");
  } finally {
    closeSync(fd);
  }
  return () => {
    try {
      // Another start's session keeps the shared scaffolding it now uses.
      if (readdirSync(sessions).some((entry) => entry !== id)) return;
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") throw error;
    }
    try {
      const current = lstatSync(path);
      if (current.dev === owned.dev && current.ino === owned.ino) unlinkSync(path);
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") throw error;
    }
  };
}
