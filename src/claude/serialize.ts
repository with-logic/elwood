/**
 * Converts typed hook handler results to Claude hook process output.
 * Implements PRD §6.4.
 */

import type { BridgeProcessResult } from "../bridge/types.ts";
import type {
  ClaudeHookEventName,
  ClaudeHookResult,
  PermissionRequestResult,
} from "./hooks/index.ts";

export function serializeHookResult(
  eventName: ClaudeHookEventName,
  result: ClaudeHookResult,
): BridgeProcessResult {
  if (result === undefined) return { exitCode: 0, stdout: "", stderr: "" };
  if ("behavior" in result) return jsonOutput(permissionRequest(eventName, result));
  if ("retry" in result)
    return jsonOutput({ hookSpecificOutput: { hookEventName: eventName, retry: true } });
  if ("worktreePath" in result) return worktree(result.worktreePath);
  if ("decision" in result) return jsonOutput(topLevel(eventName, result));
  if ("continue" in result) return jsonOutput(result);
  // PreToolUse decisions, elicitation actions, and context/output fields all
  // travel as hook-specific output keyed by the event name.
  return jsonOutput({ hookSpecificOutput: { hookEventName: eventName, ...result } });
}

function jsonOutput(value: unknown): BridgeProcessResult {
  return { exitCode: 0, stdout: `${JSON.stringify(value)}\n`, stderr: "" };
}

function permissionRequest(eventName: string, result: PermissionRequestResult): unknown {
  return { hookSpecificOutput: { hookEventName: eventName, decision: result } };
}

function topLevel(
  eventName: string,
  result: {
    readonly decision: "block";
    readonly reason: string;
    readonly additionalContext?: string;
  },
): unknown {
  return {
    decision: result.decision,
    reason: result.reason,
    ...(result.additionalContext === undefined
      ? {}
      : {
          hookSpecificOutput: {
            hookEventName: eventName,
            additionalContext: result.additionalContext,
          },
        }),
  };
}

function worktree(path: string): BridgeProcessResult {
  return { exitCode: 0, stdout: `${path}\n`, stderr: "" };
}
