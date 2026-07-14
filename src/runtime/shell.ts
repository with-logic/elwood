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
 * Login (non-interactive) shell for one-shot preflight probes (`--version`,
 * `update`, `--help`). `-l` resolves the user's PATH from login files; dropping
 * `-i` skips the expensive interactive `.zshrc`/prompt setup a probe never
 * needs, so probes stay fast and off the host's critical path (§9.2).
 */
export function probeShellCommand(command: string): readonly string[] {
  return ["-l", "-c", command];
}
