/**
 * Flag/value launch-argument pairs shared by the adapters' shell commands and the
 * foreground `elwood interactive` spawn, so one mapping serves both launch paths.
 * Implements PRD §4.2 and §12A.9.
 */

import { shellQuote } from "./shell.ts";

/** One agent argument: a flag or bare word followed by its value. */
export type LaunchArgument = readonly [flag: string, value: string];

/** The argv form for a direct `spawn` (no shell, nothing quoted). */
export function launchArgv(args: readonly LaunchArgument[]): readonly string[] {
  return args.flatMap((argument) => [argument[0], argument[1]]);
}

/** The login-shell form: flags stay bare, every value is single-quoted. */
export function launchShellWords(args: readonly LaunchArgument[]): readonly string[] {
  return args.map((argument) => `${argument[0]} ${shellQuote(argument[1])}`);
}
