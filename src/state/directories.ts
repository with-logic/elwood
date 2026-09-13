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
    try {
      const info = lstatSync(current);
      if (info.isSymbolicLink() && (current === leaf || info.uid !== 0)) {
        throw elwoodError("state_corrupt", `State path must not follow a symlink: ${current}`);
      }
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export function makeStateDirectory(path: string, mode: number): void {
  assertStatePath(path);
  mkdirSync(path, { recursive: true, mode });
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
