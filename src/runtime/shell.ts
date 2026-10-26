/**
 * User shell helpers shared by preflight and PTY launch.
 * Implements PRD §4.2 and the probe start line of §9.2 (C-PTY-08, C-PERF-05).
 */

import { userInfo } from "node:os";
import { probeScript, probeStatusScript } from "./probe/start.ts";

export function userShell(): string {
  return userInfo().shell || "/bin/zsh";
}

/**
 * Quote one argument for the POSIX login shells used by both adapters: wrap in
 * single quotes, escaping embedded single quotes as '\''.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** The login shell's arguments; the script to run is always the fourth. */
export type LoginShellArgs = readonly ["-l", "-i", "-c", string];

/** Interactive login shell for the agent PTY — matches Terminal.app (§4.2). */
export function loginShellCommand(command: string): LoginShellArgs {
  return ["-l", "-i", "-c", command];
}

/**
 * Interactive login shell for the non-PTY probes (`--version`, `update`, `--help`).
 * The same shell and flags as `loginShellCommand` (C-PTY-08): the probes and the agent
 * PTY must resolve the same CLI installation, so a probe loads the same user PATH the
 * PTY launch does, and `exec`s its command as the PTY launch does. The one divergence is the
 * probe script: a start line, so the probe runner can bound the user's profile and the CLI
 * separately (C-PERF-05), and private output files, so only the command's own output is
 * captured (§9.2). `command` must be one program the shell can `exec`, with its arguments.
 */
export function probeShellCommand(command: string): LoginShellArgs {
  return loginShellCommand(probeScript(command));
}

/** The same login shell, for a shell builtin answered by its exit status alone (`command -v`). */
export function probeShellStatus(command: string): LoginShellArgs {
  return loginShellCommand(probeStatusScript(command));
}
