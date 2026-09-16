/**
 * Symlink-safe, ownership-checked reads of Elwood's private (0600) files.
 * Implements PRD §8.2 and §12A.5: a session record or loop sidecar is rejected as
 * `state_corrupt` unless it is a regular file owned by the current user with no
 * group/world bits. The file is opened with O_NOFOLLOW and the SAME descriptor is
 * fstat()ed and read, so there is no check-then-use window between the privacy
 * check and the read.
 */

import { closeSync, constants, fstatSync, openSync, readFileSync, type Stats } from "node:fs";
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
 * group/world accessible, or cannot be read for any other reason.
 */
export function readPrivateFile(
  path: string,
  owner: FileOwner | undefined,
  corrupt: (reason: string) => Error,
): string | undefined {
  const outcome = inspect(path, owner);
  if (outcome === undefined) return undefined;
  if ("fault" in outcome) throw corrupt(outcome.fault);
  return outcome.text;
}

function inspect(path: string, owner: FileOwner | undefined): Outcome {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const fault = privacyFault(fstatSync(fd), owner);
    return fault === undefined ? { text: readFileSync(fd, "utf8") } : { fault };
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
