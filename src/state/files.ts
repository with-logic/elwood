/**
 * Secure state path and file helpers for Elwood metadata.
 * Implements PRD §6.2 and §8.2.
 */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { elwoodError } from "../core/errors.ts";
import { assertStatePath, makeStateDirectory } from "./directories.ts";

export function newBridgeToken(): string {
  return randomUUID();
}

export function assertSessionId(id: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id === "." || id === "..") {
    throw elwoodError("state_not_found", `Invalid Elwood session id: ${id}`);
  }
}

export function safeSessionDir(stateDir: string, id: string): string {
  assertSessionId(id);
  const root = resolve(stateDir);
  return join(root, "sessions", id);
}

export function secureMkdir(path: string): void {
  makeStateDirectory(path, 0o700);
}

export function sharedMkdir(path: string): void {
  makeStateDirectory(path, 0o755);
}

export function writeSharedFile(path: string, content: string): void {
  sharedMkdir(dirname(path));
  writeStateFile(path, content, 0o644);
}

export function writePrivateFile(path: string, content: string): void {
  secureMkdir(dirname(path));
  writeStateFile(path, content, 0o600);
}

/**
 * Rename-atomic, fsync-backed private write (§8.2). The temp name carries a random
 * suffix as well as the pid so two writers in one process (or a recycled pid) never
 * share a temp file; on any failure the temp file is removed so a crashed write
 * leaves no `*.tmp-*` litter beside the record.
 */
export function writePrivateFileAtomic(path: string, content: string): void {
  secureMkdir(dirname(path));
  const tmp = `${path}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  try {
    const fd = openSync(
      tmp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(fd, content);
      fchmodSync(fd, 0o600);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  fsyncDir(dirname(path));
}

export function fsyncDir(path: string): void {
  if (!existsSync(path)) return;
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Validate before truncation; no-follow also rejects a planted leaf link. */
function writeStateFile(path: string, content: string, mode: number): void {
  assertStatePath(path);
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    mode,
  );
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== process.getuid?.() || info.nlink !== 1) {
      throw elwoodError(
        "state_corrupt",
        `State file must be an owned, single-link regular file: ${path}`,
      );
    }
    fchmodSync(fd, mode);
    ftruncateSync(fd, 0);
    writeFileSync(fd, content);
  } finally {
    closeSync(fd);
  }
}
