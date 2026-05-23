/**
 * Builds the shell command used to launch interactive Claude.
 * Implements PRD §4.2 and §9.1.
 */

import type { StartClaudeOptions } from "../core/types.ts";

export function buildClaudeShellCommand(settingsPath: string, options: StartClaudeOptions): string {
  const parts = ["exec", "claude", "--settings", shellQuote(settingsPath)];
  if (options.permissionMode) {
    parts.push("--permission-mode", shellQuote(options.permissionMode));
  }
  if (options.allowedTools && options.allowedTools.length > 0) {
    parts.push("--tools", shellQuote(options.allowedTools.join(",")));
  }
  if (options.name) {
    parts.push("--name", shellQuote(options.name));
  }
  return parts.join(" ");
}

export function shellLaunch(
  shell: string,
  command: string,
): { readonly command: string; readonly args: readonly string[] } {
  return { command: shell, args: ["-l", "-i", "-c", command] };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
