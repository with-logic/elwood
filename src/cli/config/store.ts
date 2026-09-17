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
import { errnoCode } from "../../core/errors.ts";
import { type CliConfig, CliValidationError } from "../types.ts";
import { parseConfigText } from "./codec.ts";

export type ConfigIdentity = { readonly uid: number };
export type ConfigReadResult = { readonly config: CliConfig; readonly loaded: boolean };

export function readConfig(path: string, identity = currentIdentity()): CliConfig {
  return readConfigWithStatus(path, identity).config;
}

export function readConfigWithStatus(path: string, identity = currentIdentity()): ConfigReadResult {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    assertPrivateFile(fstatSync(fd), identity);
    return { config: parseConfigText(readFileSync(fd, "utf8")), loaded: true };
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return { config: { schemaVersion: 1 }, loaded: false };
    if (error instanceof CliValidationError)
      throw new CliValidationError(error.code, `${configLabel(path)}: ${error.message}`);
    throw invalid(`${configLabel(path)} could not be safely read.`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function writeConfig(path: string, config: CliConfig, identity = currentIdentity()): void {
  const document = `${JSON.stringify(config, null, 2)}\n`;
  parseConfigText(document);
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
    writeFileSync(fd, document);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    chmodSync(path, 0o600);
    syncDirectory(parent);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
    const code = errnoCode(error);
    throw invalid(
      `${configLabel(path)} could not be safely written${code === undefined ? "" : ` (${code})`}.`,
    );
  }
}

function assertExistingTarget(path: string, identity: ConfigIdentity): void {
  try {
    assertPrivateFile(lstatSync(path), identity);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return;
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

function invalid(message: string): CliValidationError {
  return new CliValidationError("invalid_config", message);
}

function configLabel(path: string): string {
  return `Elwood config ${JSON.stringify(path)}`;
}
