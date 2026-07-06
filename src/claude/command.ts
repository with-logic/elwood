/**
 * Builds the shell command used to launch interactive Claude.
 * Implements PRD §4.2 and §9.1.
 */

import type { StartClaudeOptions } from "../core/types.ts";
import { loginShellCommand } from "../runtime/shell.ts";

export function buildClaudeShellCommand(
  settingsPath: string,
  options: StartClaudeOptions,
  resumeId?: string,
): string {
  const parts = ["exec", "claude", "--settings", shellQuote(settingsPath)];
  if (resumeId) parts.push("--resume", shellQuote(resumeId));
  if (options.model) parts.push("--model", shellQuote(options.model));
  if (options.permissionMode) {
    parts.push("--permission-mode", shellQuote(options.permissionMode));
  }
  if (options.allowedTools && options.allowedTools.length > 0) {
    parts.push("--allowedTools", shellQuote(options.allowedTools.join(",")));
  }
  if (options.disallowedTools && options.disallowedTools.length > 0)
    parts.push("--disallowedTools", shellQuote(options.disallowedTools.join(",")));
  if (options.name) {
    parts.push("--name", shellQuote(options.name));
  }
  return parts.join(" ");
}

export function shellLaunch(
  shell: string,
  command: string,
): { readonly command: string; readonly args: readonly string[] } {
  return { command: shell, args: loginShellCommand(command) };
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
