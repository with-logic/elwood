/**
 * User shell helpers shared by preflight and PTY launch.
 * Implements PRD §4.2 and the probe start line of §9.2 (C-PTY-08, C-PERF-05).
 */

import { userInfo } from "node:os";
import { probeCommandStartLine } from "./probe-start.ts";

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
 * The same shell and flags as `loginShellCommand` (C-PTY-08): the probes and the agent
 * PTY must resolve the same CLI installation, so a probe loads the same user PATH the
 * PTY launch does. The one divergence is the start line written before the command,
 * so the probe runner can bound the user's profile and the CLI separately (C-PERF-05).
 */
export function probeShellCommand(command: string): readonly string[] {
  return loginShellCommand(`echo ${probeCommandStartLine} >&2; ${command}`);
}
