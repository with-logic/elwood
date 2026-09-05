/**
 * Shell-friendly global config path/show/get/set/unset commands.
 * Implements PRD §12A.4 and C-CLI-14/C-CLI-15.
 */

import type { AsyncOutputSink } from "../stream.ts";
import { type CliEnvironment, CliValidationError } from "../types.ts";
import { getConfigValue, setConfigValue, unsetConfigValue } from "./codec.ts";
import { resolveConfigPath } from "./paths.ts";
import { readConfig, writeConfig } from "./store.ts";

export type ConfigCommandContext = {
  readonly env: CliEnvironment;
  readonly invocationCwd: string;
  readonly homeDir: string;
  readonly stdout: AsyncOutputSink;
};

/** Execute one config command without importing or launching an agent adapter. */
export async function runConfigCommand(
  args: readonly string[],
  context: ConfigCommandContext,
): Promise<void> {
  const [command, ...rest] = args;
  const path = resolveConfigPath(context.env, context.invocationCwd, context.homeDir);
  if (command === "path" && rest.length === 0) {
    await context.stdout.write(`${path}\n`);
    return;
  }
  if (command === "show" && rest.length === 0) {
    await context.stdout.write(`${JSON.stringify(readConfig(path), null, 2)}\n`);
    return;
  }
  if (command === "get" && rest.length === 1) {
    const value = getConfigValue(readConfig(path), required(rest[0], "key"));
    if (value !== undefined) await context.stdout.write(`${String(value)}\n`);
    return;
  }
  if (command === "set" && rest.length === 2) {
    writeConfig(
      path,
      setConfigValue(readConfig(path), required(rest[0], "key"), required(rest[1], "value")),
    );
    return;
  }
  if (command === "unset" && rest.length === 1) {
    writeConfig(path, unsetConfigValue(readConfig(path), required(rest[0], "key")));
    return;
  }
  throw usage("Usage: elwood config <path|show|get|set|unset> [key] [value]");
}

function required(value: string | undefined, label: string): string {
  if (value === undefined || value.trim() === "") throw usage(`Config ${label} is required.`);
  return value;
}

function usage(message: string): CliValidationError {
  return new CliValidationError("invalid_arguments", message);
}
