/**
 * Builds the launch arguments and shell command used to start interactive Claude.
 * The argument list is shared by the headless PTY launch and `elwood interactive`
 * (§12A.9), so the Elwood-to-Claude flag mapping cannot drift between them.
 * Implements PRD §4.2, §9.1, and §12A.9.
 */

import type { StartClaudeOptions } from "../core/types.ts";
import { type LaunchArgument, launchShellWords } from "../runtime/launch-arguments.ts";
import { loginShellCommand, shellQuote } from "../runtime/shell.ts";

/** The subset of start options that become Claude's own command-line flags. */
export type ClaudeLaunchArgumentOptions = Pick<
  StartClaudeOptions,
  | "model"
  | "reasoningEffort"
  | "permissionMode"
  | "allowedTools"
  | "disallowedTools"
  | "tools"
  | "name"
>;

/** Claude's native flags for a launch, in stable order (no `--settings`). */
export function claudeLaunchArguments(
  options: ClaudeLaunchArgumentOptions,
  resumeId?: string,
): readonly LaunchArgument[] {
  const parts: LaunchArgument[] = [];
  if (resumeId) parts.push(["--resume", resumeId]);
  if (options.model) parts.push(["--model", options.model]);
  // Validated before spawn in the preflight (C-CLAUDE-20); forwarded verbatim here.
  if (options.reasoningEffort) parts.push(["--effort", options.reasoningEffort]);
  if (options.permissionMode) parts.push(["--permission-mode", options.permissionMode]);
  if (options.allowedTools && options.allowedTools.length > 0) {
    parts.push(["--allowedTools", options.allowedTools.join(",")]);
  }
  if (options.disallowedTools && options.disallowedTools.length > 0)
    parts.push(["--disallowedTools", options.disallowedTools.join(",")]);
  // --tools is a true allowlist; an empty list ("") disables all tools.
  if (options.tools !== undefined) parts.push(["--tools", options.tools.join(",")]);
  if (options.name) parts.push(["--name", options.name]);
  return parts;
}

export function buildClaudeShellCommand(
  settingsPath: string,
  options: StartClaudeOptions,
  resumeId?: string,
): string {
  const parts = ["exec", "claude", "--settings", shellQuote(settingsPath)];
  parts.push(...launchShellWords(claudeLaunchArguments(options, resumeId)));
  return parts.join(" ");
}

export function shellLaunch(
  shell: string,
  command: string,
): { readonly command: string; readonly args: readonly string[] } {
  return { command: shell, args: loginShellCommand(command) };
}
