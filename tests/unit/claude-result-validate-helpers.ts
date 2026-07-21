/**
 * Shared helpers for Claude hook result validation tests.
 * Supports PRD §6.4, C-HOOK-06, C-HOOK-09, and C-HRESP-01 coverage.
 */

import type { ClaudeToolInputByName } from "../../src/claude/tool-types.ts";
import { isClaudeHookResult } from "../../src/claude/validate-result.ts";

export function updateFor(
  tool: ClaudeToolInputByName,
  updatedInput: Readonly<Record<string, unknown>>,
): boolean {
  return isClaudeHookResult(
    { hook_event_name: "PreToolUse", session_id: "claude-1", cwd: "/tmp/project", ...tool },
    { permissionDecision: "allow", updatedInput },
  );
}

export function permReq(
  event: Readonly<Record<string, unknown>>,
  result: Readonly<Record<string, unknown>>,
): boolean {
  return isClaudeHookResult(
    { session_id: "claude-1", cwd: "/tmp/project", tool_input: {}, ...event } as never,
    result,
  );
}
