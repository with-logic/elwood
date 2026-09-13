/**
 * Parsed shapes for the non-run first-argument commands.
 * Implements PRD §12A.7 through §12A.10 and C-CLI-23 through C-CLI-26.
 */

import type { ParsedRunCommand } from "./types.ts";

export const cliSubcommands = ["resume", "interactive", "sessions", "models"] as const;
export type CliSubcommand = (typeof cliSubcommands)[number];

/**
 * `sessions` and `models` reuse the run option grammar (state directory, output,
 * agent, workspace, posture) so precedence and validation stay identical to a run.
 */
export type ParsedListCommand<C extends "sessions" | "models" = "sessions" | "models"> = {
  readonly command: C;
  readonly run: ParsedRunCommand;
};

/**
 * `interactive [id]` carries its settings as a run whose `resume` flag is the
 * optional id, so stored-record loading follows exact `--resume` semantics.
 */
export type ParsedInteractiveCommand = {
  readonly command: "interactive";
  readonly run: ParsedRunCommand;
  readonly id?: string;
};

export function isCliSubcommand(value: string | undefined): value is CliSubcommand {
  return cliSubcommands.includes(value as CliSubcommand);
}
