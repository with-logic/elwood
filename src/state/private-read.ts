/**
 * Symlink-safe, ownership-checked reads of Elwood's private (0600) files.
 * Implements PRD §8.2 and §12A.5: a session record or loop sidecar is rejected as
 * `state_corrupt` unless it is a regular file owned by the current user with no
 * group/world bits. The file is opened with O_NOFOLLOW and the SAME descriptor is
 * fstat()ed and read, so there is no check-then-use window between the privacy
 * check and the read.
 */

import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  type Stats,
} from "node:fs";
import { errnoCode, toError } from "../core/errors.ts";

export type FileOwner = { readonly uid: number };

/** The current user, or `undefined` where the platform reports no uid (never trusted as private). */
export function currentFileOwner(): FileOwner | undefined {
  const uid = process.getuid?.();
  return uid === undefined ? undefined : { uid };
}

type Outcome = { readonly text: string } | { readonly fault: string } | undefined;

/**
 * Read a private file. Returns `undefined` when the file is absent (ENOENT); throws
 * `corrupt(reason)` when it is a symlink, not a regular file, owned by another user,
 * group/world accessible, exceeds an optional byte limit, or cannot be read for any other reason.
 */
export function readPrivateFile(
  path: string,
  owner: FileOwner | undefined,
  corrupt: (reason: string) => Error,
  maxBytes?: number,
): string | undefined {
  const outcome = inspect(path, owner, maxBytes);
  if (outcome === undefined) return undefined;
  if ("fault" in outcome) throw corrupt(outcome.fault);
  return outcome.text;
}

function inspect(path: string, owner: FileOwner | undefined, maxBytes?: number): Outcome {
  let fd: number | undefined;
  try {
    // O_NONBLOCK: opening a FIFO read-only would otherwise block until a writer appears.
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    const fault = privacyFault(stat, owner);
    if (fault !== undefined) return { fault };
    if (maxBytes === undefined) return { text: readFileSync(fd, "utf8") };
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    const count = readSync(fd, buffer, 0, buffer.length, 0);
    return count !== stat.size || count > maxBytes
      ? { fault: "invalid bounded private file length" }
      : { text: buffer.toString("utf8", 0, count) };
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return undefined;
    return { fault: toError(error).message };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function privacyFault(stat: Stats, owner: FileOwner | undefined): string | undefined {
  if (!stat.isFile()) return "not a regular file";
  if (owner === undefined) return "file owner cannot be verified";
  if (stat.uid !== owner.uid) return "not owned by the current user";
  if ((stat.mode & 0o077) !== 0) return "group or world accessible";
  return undefined;
}
