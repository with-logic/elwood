/**
 * Runtime validation for Claude tool input rewrite payloads.
 * Implements PRD §6.4 tool-specific response validation.
 */

export function isClaudeToolInputUpdate(toolName: string | undefined, value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  if (toolName === "Agent") return keys(value, ["prompt", "description", "subagent_type", "model"]);
  if (toolName === "AskUserQuestion") return keys(value, ["questions", "answers"]);
  if (toolName === "Bash" || toolName === "PowerShell") {
    return keys(value, ["command", "description", "timeout", "run_in_background"]);
  }
  if (toolName === "Edit")
    return keys(value, ["file_path", "old_string", "new_string", "replace_all"]);
  if (toolName === "ExitPlanMode") return keys(value, ["allowedPrompts", "plan", "planFilePath"]);
  if (toolName === "Glob") return keys(value, ["pattern", "path"]);
  if (toolName === "Grep")
    return keys(value, ["pattern", "path", "glob", "output_mode", "-i", "multiline"]);
  if (toolName === "Read") return keys(value, ["file_path", "offset", "limit"]);
  if (toolName === "WebFetch") return keys(value, ["url", "prompt"]);
  if (toolName === "WebSearch") return keys(value, ["query", "allowed_domains", "blocked_domains"]);
  if (toolName === "Write") return keys(value, ["file_path", "content"]);
  return true;
}

function keys(value: Readonly<Record<string, unknown>>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
