/**
 * User shell helpers shared by preflight and PTY launch.
 * Implements PRD §4.2.
 */

import { userInfo } from "node:os";

export function userShell(): string {
  return userInfo().shell || "/bin/zsh";
}

export function loginShellCommand(command: string): readonly string[] {
  return ["-l", "-i", "-c", command];
}
