/**
 * Shell-friendly global config path/show/get/set/unset commands.
 * Implements PRD §12A.4 and C-CLI-14/C-CLI-15.
 */

import { cliConfigHelp } from "../help.ts";
import { usage } from "../request/values.ts";
import type { AsyncOutputSink } from "../stream.ts";
import type { CliEnvironment } from "../types.ts";
import { getConfigValue, setConfigValue, unsetConfigValue } from "./codec.ts";
import { writeEffectiveConfig } from "./effective.ts";
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
  if ((command === "help" || command === "--help" || command === "-h") && rest.length === 0) {
    await context.stdout.write(cliConfigHelp);
    return;
  }
  if (command === "effective") {
    if (rest.length === 1 && (rest[0] === "--help" || rest[0] === "-h")) {
      await context.stdout.write(cliConfigHelp);
      return;
    }
    await writeEffectiveConfig(rest, context);
    return;
  }
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
  throw usage("Usage: elwood config <path|show|effective|get|set|unset> [key] [value]");
}

function required(value: string | undefined, label: string): string {
  if (value === undefined || value.trim() === "") throw usage(`Config ${label} is required.`);
  return value;
}
