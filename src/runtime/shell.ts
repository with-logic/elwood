/**
 * User shell helpers shared by preflight and PTY launch.
 * Implements PRD §4.2.
 */

export function userShell(): string {
  return process.env["SHELL"] ?? "/bin/zsh";
}

export function loginShellCommand(command: string): readonly string[] {
  return ["-l", "-i", "-c", command];
}
