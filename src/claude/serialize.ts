/**
 * Converts typed hook handler results to Claude hook process output.
 * Implements PRD §6.4.
 */

import type { BridgeProcessResult } from "../bridge/types.ts";
import type { ClaudeHookEventName, ClaudeHookResult } from "./hooks.ts";

export function serializeHookResult(
  eventName: ClaudeHookEventName,
  result: ClaudeHookResult,
): BridgeProcessResult {
  if (result === undefined) return { exitCode: 0, stdout: "", stderr: "" };
  if ("permissionDecision" in result) return jsonOutput(preToolUse(eventName, result));
  if ("behavior" in result) return jsonOutput(permissionRequest(eventName, result));
  if ("retry" in result)
    return jsonOutput({ hookSpecificOutput: { hookEventName: eventName, retry: true } });
  if ("worktreePath" in result) return worktree(eventName, result.worktreePath);
  if ("action" in result)
    return jsonOutput({ hookSpecificOutput: { hookEventName: eventName, ...result } });
  if ("decision" in result) return jsonOutput(topLevel(eventName, result));
  return jsonOutput({ hookSpecificOutput: { hookEventName: eventName, ...result } });
}

function jsonOutput(value: unknown): BridgeProcessResult {
  return { exitCode: 0, stdout: `${JSON.stringify(value)}\n`, stderr: "" };
}

function preToolUse(eventName: string, result: Exclude<ClaudeHookResult, void>): unknown {
  return { hookSpecificOutput: { hookEventName: eventName, ...result } };
}

function permissionRequest(
  eventName: string,
  result: { readonly behavior: "allow" | "deny" },
): unknown {
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

function worktree(eventName: string, path: string): BridgeProcessResult {
  if (eventName === "WorktreeCreate") return { exitCode: 0, stdout: `${path}\n`, stderr: "" };
  return jsonOutput({ hookSpecificOutput: { hookEventName: eventName, worktreePath: path } });
}
