/**
 * Secure state path and file helpers for Elwood metadata.
 * Implements PRD §6.2 and §8.2.
 */

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { elwoodError } from "../core/errors.ts";

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
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

export function sharedMkdir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o755 });
  chmodSync(path, 0o755);
}

export function writeSharedFile(path: string, content: string): void {
  sharedMkdir(dirname(path));
  writeFileSync(path, content, { mode: 0o644 });
  chmodSync(path, 0o644);
}

export function writePrivateFile(path: string, content: string): void {
  secureMkdir(dirname(path));
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function writePrivateFileAtomic(path: string, content: string): void {
  secureMkdir(dirname(path));
  const tmp = `${path}.tmp-${process.pid}`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  chmodSync(path, 0o600);
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
