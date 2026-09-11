/** Shared fixtures for the `--high-trust` CLI tests (C-CLI-22). */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCliArgs } from "../../src/cli/args/index.ts";
import type { ParsedRunCommand } from "../../src/cli/types.ts";

export function root(): string {
  return mkdtempSync(join(tmpdir(), "elwood-high-trust-"));
}

export function run(argv: readonly string[]): ParsedRunCommand {
  const parsed = parseCliArgs(argv);
  if (parsed.command !== "run") throw new Error("expected run");
  return parsed;
}

export function context(cwd: string, env: Readonly<Record<string, string | undefined>> = {}) {
  return { env, homeDir: cwd, invocationCwd: cwd };
}

/** Writes a private version-1 config document and returns its path. */
export function savedConfig(cwd: string, document: Readonly<Record<string, unknown>>): string {
  const path = join(cwd, "config.json");
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, ...document }), { mode: 0o600 });
  return path;
}
