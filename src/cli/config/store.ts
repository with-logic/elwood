/**
 * Owner-only, symlink-safe, atomic persistence for global CLI configuration.
 * Implements PRD §12A.4 and C-CLI-15.
 */

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { type CliConfig, CliValidationError } from "../types.ts";
import { parseConfigText } from "./codec.ts";

export type ConfigIdentity = { readonly uid: number };

export function readConfig(path: string, identity = currentIdentity()): CliConfig {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    assertPrivateFile(fstatSync(fd), identity);
    return parseConfigText(readFileSync(fd, "utf8"));
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { schemaVersion: 1 };
    if (error instanceof CliValidationError) throw error;
    throw invalid("Could not safely read Elwood config.");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function writeConfig(path: string, config: CliConfig, identity = currentIdentity()): void {
  parseConfigText(JSON.stringify(config));
  assertExistingTarget(path, identity);
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${randomUUID()}`;
  let fd: number | undefined;
  try {
    fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(fd, `${JSON.stringify(config, null, 2)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    chmodSync(path, 0o600);
    syncDirectory(parent);
  } catch {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
    throw invalid("Could not safely write Elwood config.");
  }
}

function assertExistingTarget(path: string, identity: ConfigIdentity): void {
  try {
    assertPrivateFile(lstatSync(path), identity);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    if (error instanceof CliValidationError) throw error;
    throw invalid("Could not inspect Elwood config.");
  }
}

function assertPrivateFile(
  stat: { readonly uid: number; readonly mode: number; readonly isFile: () => boolean },
  identity: ConfigIdentity,
): void {
  if (!stat.isFile()) throw invalid("Elwood config must be a regular file, not a symlink.");
  if (stat.uid !== identity.uid) throw invalid("Elwood config must be owned by the current user.");
  if ((stat.mode & 0o077) !== 0) throw invalid("Elwood config permissions must be owner-only.");
}

function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function currentIdentity(): ConfigIdentity {
  return { uid: process.getuid!() };
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function invalid(message: string): CliValidationError {
  return new CliValidationError("invalid_config", message);
}
