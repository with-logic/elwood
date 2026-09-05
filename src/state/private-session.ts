/**
 * Private, symlink-safe CLI session-record reads and identity cleanup.
 * Implements PRD §12A.2/§12A.5 and C-CLI-08/C-CLI-15/C-CLI-16.
 */

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  type Stats,
} from "node:fs";
import { join, resolve } from "node:path";
import { ElwoodError, elwoodError } from "../core/errors.ts";
import { assertSessionId, safeSessionDir } from "./files.ts";
import { sessionSocketHome } from "./socket-home.ts";
import { removeSessionFiles, type SessionRecord } from "./store.ts";
import { validateSessionRecord } from "./validate.ts";

export type SessionOwner = { readonly uid: number };

/** Read one CLI-owned record without following links or trusting shared metadata. */
export function readPrivateSessionRecord(
  stateDir: string,
  id: string,
  owner: SessionOwner = { uid: process.getuid!() },
): SessionRecord {
  assertSessionId(id);
  const root = resolve(stateDir);
  const sessionDir = safeSessionDir(root, id);
  let fd: number | undefined;
  try {
    assertPrivateDirectory(lstatSync(root), owner);
    assertPrivateDirectory(lstatSync(join(root, "sessions")), owner);
    assertPrivateDirectory(lstatSync(sessionDir), owner);
    fd = openSync(join(sessionDir, "session.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
    assertPrivateFile(fstatSync(fd), owner);
    const parsed = validateSessionRecord(JSON.parse(readFileSync(fd, "utf8")), id);
    if (!parsed) throw corrupt(id);
    return parsed;
  } catch (error) {
    if (isErrno(error, "ENOENT"))
      throw elwoodError("state_not_found", `No Elwood session found for ${id}`);
    if (error instanceof ElwoodError) throw error;
    throw corrupt(id);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Remove record and stable socket home when no live session object owns teardown. */
export function removeSessionIdentity(
  stateDir: string,
  id: string,
  adapter: "claude" | "codex",
): void {
  const socketHome = sessionSocketHome({
    stateDir: resolve(stateDir),
    elwoodSessionId: id,
    adapter,
  });
  removeSessionFiles({ stateDir, elwoodSessionId: id, socketPath: join(socketHome, "owned.sock") });
}

function assertPrivateDirectory(stat: Stats, owner: SessionOwner): void {
  if (!stat.isDirectory()) throw corrupt("record");
  assertPrivate(stat, owner);
}

function assertPrivateFile(stat: Stats, owner: SessionOwner): void {
  if (!stat.isFile()) throw corrupt("record");
  assertPrivate(stat, owner);
}

function assertPrivate(stat: Stats, owner: SessionOwner): void {
  if (stat.uid !== owner.uid || (stat.mode & 0o077) !== 0) throw corrupt("record");
}

function corrupt(id: string): ElwoodError {
  return elwoodError("state_corrupt", `Session state is not private or valid for ${id}`);
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
