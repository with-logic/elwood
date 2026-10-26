/**
 * Private, symlink-safe CLI session-record reads and identity cleanup.
 * Implements PRD §12A.2/§12A.5 and C-CLI-08/C-CLI-15/C-CLI-16.
 */

import { closeSync, constants, fstatSync, lstatSync, openSync, type Stats } from "node:fs";
import { join, resolve } from "node:path";
import { ElwoodError, elwoodError, errnoCode } from "../core/errors.ts";
import { assertStatePath, makeStateDirectory, PRIVATE_STATE_MODE } from "./directories.ts";
import { assertSessionId, safeSessionDir } from "./files.ts";
import { hasLaunchOwner } from "./launch-ownership.ts";
import type { FileOwner } from "./private-read.ts";
import { makeStateRoot, makeStateTree } from "./root.ts";
import { sessionSocketHome } from "./socket-home.ts";
import { readSessionRecord, removeSessionFiles, type SessionRecord } from "./store.ts";

export type SessionOwner = FileOwner;

/**
 * Create or validate the CLI state root for a session in `cwd` without following a planted
 * root symlink. The root is made only while `cwd` exists, and never makes it (C-STATE-14).
 */
export function ensurePrivateStateRoot(
  stateDir: string,
  cwd: string,
  owner: SessionOwner = { uid: process.getuid!() },
): void {
  const root = resolve(stateDir);
  const sessions = join(root, "sessions");
  makeStateTree(cwd, sessions, () => {
    // Made without `prepareStateDirectory`'s chmod: an existing root keeps its mode, so a
    // shared one is rejected below instead of being made private (C-CLI-15).
    const makeRoot = () => makeStateRoot(root, PRIVATE_STATE_MODE, cwd, makeStateDirectory);
    ensurePrivateDirectory(root, owner, makeRoot);
    ensurePrivateDirectory(sessions, owner, () =>
      makeStateDirectory(sessions, PRIVATE_STATE_MODE, "inside-parent"),
    );
  });
}

/** Makes `path` with `make`, then requires a private directory `owner` owns. */
function ensurePrivateDirectory(path: string, owner: SessionOwner, make: () => void): void {
  let fd: number | undefined;
  try {
    assertStatePath(path);
    make();
    fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    assertPrivateDirectory(fstatSync(fd), owner);
  } catch (error) {
    // ENOENT is a directory removed meanwhile, which `makeStateTree` retries or reports as such.
    if (error instanceof ElwoodError || errnoCode(error) === "ENOENT") throw error;
    throw corrupt("root");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Read one CLI-owned record without following links or trusting shared metadata: every
 * directory on the path must be a private directory owned by `owner`, and the record
 * itself is read through the shared O_NOFOLLOW + fstat path (`readSessionRecord`).
 */
export function readPrivateSessionRecord(
  stateDir: string,
  id: string,
  owner: SessionOwner = { uid: process.getuid!() },
): SessionRecord {
  assertSessionId(id);
  const root = resolve(stateDir);
  const sessionDir = safeSessionDir(root, id);
  try {
    assertPrivateDirectory(lstatSync(root), owner);
    assertPrivateDirectory(lstatSync(join(root, "sessions")), owner);
    assertPrivateDirectory(lstatSync(sessionDir), owner);
  } catch (error) {
    if (errnoCode(error) === "ENOENT")
      throw elwoodError("state_not_found", `No Elwood session found for ${id}`);
    if (error instanceof ElwoodError) throw error;
    throw corrupt(id);
  }
  try {
    return readSessionRecord(root, id, owner);
  } catch (error) {
    // Absence stays `state_not_found`; any other read failure (unsafe file, unreadable,
    // invalid) is this path's own `state_corrupt` (§12A.5).
    if (errnoCode(error) === "state_not_found") throw error;
    throw corrupt(id);
  }
}

/** Remove record and socket home only when no live launch or pending reservation owns them. */
export function removeSessionIdentity(
  stateDir: string,
  id: string,
  adapter: "claude" | "codex",
): void {
  const root = resolve(stateDir);
  assertPrivateDirectoryIfPresent(root);
  assertPrivateDirectoryIfPresent(join(root, "sessions"));
  if (hasLaunchOwner(safeSessionDir(root, id))) return;
  const socketHome = sessionSocketHome({ stateDir: root, elwoodSessionId: id, adapter });
  removeSessionFiles({ stateDir, elwoodSessionId: id, socketHome });
}

function assertPrivateDirectoryIfPresent(path: string): void {
  try {
    assertPrivateDirectory(lstatSync(path), { uid: process.getuid!() });
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return;
    if (error instanceof ElwoodError) throw error;
    throw corrupt("root");
  }
}

function assertPrivateDirectory(stat: Stats, owner: SessionOwner): void {
  if (!stat.isDirectory()) throw corrupt("record");
  assertPrivate(stat, owner);
}

function assertPrivate(stat: Stats, owner: SessionOwner): void {
  if (stat.uid !== owner.uid || (stat.mode & 0o077) !== 0) throw corrupt("record");
}

function corrupt(id: string): ElwoodError {
  return elwoodError("state_corrupt", `Session state is not private or valid for ${id}`);
}
