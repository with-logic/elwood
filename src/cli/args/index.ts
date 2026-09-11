/**
 * Parses Elwood's hybrid direct/explicit command grammar without side effects.
 * Implements PRD §12A.1/§12A.7-§12A.10 and C-CLI-02/C-CLI-04/C-CLI-06/C-CLI-23.
 */

import { parseArgs } from "node:util";
import { parseSubcommand } from "../args-commands.ts";
import { isCliSubcommand } from "../command-types.ts";
import {
  CliValidationError,
  type ParsedCliCommand,
  type RunFlags,
  type RunOptionKey,
} from "../types.ts";
import { argumentErrorMessage } from "./errors.ts";
import { parseOptions, runOptionTable } from "./options.ts";

export function parseCliArgs(argv: readonly string[]): ParsedCliCommand {
  if (argv.length === 0) return { command: "help" };
  if (argv[0] === "help") return { command: "help" };
  if (argv[0] === "config") return { command: "config", args: argv.slice(1) };
  if (isCliSubcommand(argv[0])) return parseSubcommand(argv[0], argv.slice(1), parseRunArgs);
  return parseRunArgs(argv[0] === "run" ? argv.slice(1) : argv);
}

/** Parse run-grammar arguments (after any command word) into a run, help, or version. */
export function parseRunArgs(runArgs: readonly string[]): ParsedCliCommand {
  try {
    const parsed = parseArgs({
      args: runArgs,
      options: parseOptions,
      allowPositionals: true,
      strict: true,
      tokens: true,
    });
    if (parsed.values["help"] === true) return { command: "help" };
    if (parsed.values["version"] === true) return { command: "version" };
    rejectBooleanPair(parsed.values, "trust", "no-trust");
    rejectBooleanPair(parsed.values, "high-trust", "no-high-trust");
    rejectBooleanPair(parsed.values, "stream", "no-stream");
    rejectBooleanPair(parsed.values, "verbose", "no-verbose");
    return {
      command: "run",
      flags: flagsFrom(parsed.values),
      explicit: explicitOptions(parsed.tokens),
      promptWords: parsed.positionals,
    };
  } catch (error) {
    if (error instanceof CliValidationError) throw error;
    throw new CliValidationError("invalid_arguments", argumentErrorMessage(error));
  }
}

/** Decode parsed values through the option table; boolean options set their configured value. */
function flagsFrom(values: Readonly<Record<string, unknown>>): RunFlags {
  const flags: Record<string, unknown> = { images: [] };
  for (const [name, spec] of Object.entries(runOptionTable)) {
    const value = values[name];
    if (value === undefined) continue;
    flags[spec.key] = spec.type === "boolean" ? spec.value : value;
  }
  return flags as RunFlags;
}

function rejectBooleanPair(
  values: Readonly<Record<string, unknown>>,
  positive: string,
  negative: string,
): void {
  if (values[positive] === true && values[negative] === true) {
    throw new CliValidationError(
      "invalid_arguments",
      `--${positive} and --${negative} cannot be combined.`,
    );
  }
}

function explicitOptions(
  tokens: readonly { readonly kind: string; readonly name?: string }[],
): ReadonlySet<RunOptionKey> {
  const explicit = new Set<RunOptionKey>();
  for (const token of tokens) {
    if (token.kind !== "option" || token.name === undefined) continue;
    explicit.add(runOptionTable[token.name]!.key);
  }
  return explicit;
}
