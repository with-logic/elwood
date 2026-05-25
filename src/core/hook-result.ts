/**
 * Hook result display labels for adapter-neutral activity.
 * Implements PRD §5.4.
 */

export function hookResultLabel(result: unknown, failedOpen: boolean): string {
  if (failedOpen) return "error";
  if (result === undefined) return "no decision";
  if (!result || typeof result !== "object") return "response";
  const record = result as Record<string, unknown>;
  if (typeof record["permissionDecision"] === "string") return record["permissionDecision"];
  if (typeof record["behavior"] === "string") return record["behavior"];
  if (typeof record["decision"] === "string") return record["decision"];
  if (typeof record["additionalContext"] === "string") return "context";
  if (typeof record["action"] === "string") return record["action"];
  if (record["retry"] === true) return "retry";
  if (typeof record["worktreePath"] === "string") return "worktree";
  return "response";
}

export function transcriptActivityKind(kind: string): string {
  if (kind === "message") return "assistant_message";
  if (
    kind === "tool_call" ||
    kind === "tool_result" ||
    kind === "reasoning" ||
    kind === "web_search"
  ) {
    return kind;
  }
  return "hook";
}
