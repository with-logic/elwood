/**
 * User shell helpers shared by preflight and PTY launch.
 * Implements PRD §4.2.
 */

import { userInfo } from "node:os";

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

/** Interactive login shell for the agent PTY — matches Terminal.app (§4.2). */
export function loginShellCommand(command: string): readonly string[] {
  return ["-l", "-i", "-c", command];
}

/**
 * Interactive login shell for the non-PTY probes (`--version`, `update`, `--help`).
 * Deliberately IDENTICAL to `loginShellCommand` today (C-PTY-08): the probes and the
 * agent PTY must resolve the same CLI installation, so a probe must load the same
 * user PATH the PTY launch does. Kept as its own name so the CLI's resolution path
 * reads as a probe and any future divergence is a visible, single-site decision.
 */
export function probeShellCommand(command: string): readonly string[] {
  return loginShellCommand(command);
}
