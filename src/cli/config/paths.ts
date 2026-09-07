/**
 * Resolves global CLI config and state paths without project-local lookup.
 * Implements PRD §12A.4/§12A.5 and C-CLI-13/C-CLI-16.
 */

import { isAbsolute, join, resolve } from "node:path";
import type { CliEnvironment } from "../types.ts";

export type CliPathResolution = {
  readonly path: string;
  readonly source: "ELWOOD_CONFIG" | "XDG_CONFIG_HOME" | "XDG_STATE_HOME" | "home directory";
};

export function resolveConfigPath(
  env: CliEnvironment,
  invocationCwd: string,
  homeDir: string,
): string {
  return resolveConfigLocation(env, invocationCwd, homeDir).path;
}

export function resolveConfigLocation(
  env: CliEnvironment,
  invocationCwd: string,
  homeDir: string,
): CliPathResolution {
  const explicit = nonEmpty(env["ELWOOD_CONFIG"]);
  if (explicit !== undefined)
    return { path: resolve(invocationCwd, explicit), source: "ELWOOD_CONFIG" };
  const xdg = absoluteBase(env["XDG_CONFIG_HOME"]);
  return {
    path: join(xdg ?? join(homeDir, ".config"), "elwood", "config.json"),
    source: xdg === undefined ? "home directory" : "XDG_CONFIG_HOME",
  };
}

export function resolveStateDir(env: CliEnvironment, homeDir: string): string {
  return resolveStateLocation(env, homeDir).path;
}

export function resolveStateLocation(env: CliEnvironment, homeDir: string): CliPathResolution {
  const xdg = absoluteBase(env["XDG_STATE_HOME"]);
  return {
    path: join(xdg ?? join(homeDir, ".local", "state"), "elwood"),
    source: xdg === undefined ? "home directory" : "XDG_STATE_HOME",
  };
}

function absoluteBase(value: string | undefined): string | undefined {
  const base = nonEmpty(value);
  return base !== undefined && isAbsolute(base) ? base : undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value !== "" ? value : undefined;
}
