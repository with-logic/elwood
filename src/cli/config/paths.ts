/**
 * Resolves global CLI config and state paths without project-local lookup.
 * Implements PRD §12A.4/§12A.5 and C-CLI-13/C-CLI-16.
 */

import { isAbsolute, join, resolve } from "node:path";
import type { CliEnvironment } from "../types.ts";

export function resolveConfigPath(
  env: CliEnvironment,
  invocationCwd: string,
  homeDir: string,
): string {
  const explicit = nonEmpty(env["ELWOOD_CONFIG"]);
  if (explicit !== undefined) return resolve(invocationCwd, explicit);
  const xdg = absoluteBase(env["XDG_CONFIG_HOME"]);
  return join(xdg ?? join(homeDir, ".config"), "elwood", "config.json");
}

export function resolveStateDir(env: CliEnvironment, homeDir: string): string {
  const xdg = absoluteBase(env["XDG_STATE_HOME"]);
  return join(xdg ?? join(homeDir, ".local", "state"), "elwood");
}

function absoluteBase(value: string | undefined): string | undefined {
  const base = nonEmpty(value);
  return base !== undefined && isAbsolute(base) ? base : undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value !== "" ? value : undefined;
}
