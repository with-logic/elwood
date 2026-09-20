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
    return jsonOutput({
      hookSpecificOutput: { __proto__: null, hookEventName: eventName, retry: true },
    });
  if ("worktreePath" in result) return worktree(result.worktreePath);
  if ("decision" in result) return jsonOutput(topLevel(eventName, result));
  if ("continue" in result) return jsonOutput(result);
  // PreToolUse decisions, elicitation actions, and context/output fields all
  // travel as hook-specific output keyed by the event name.
  return jsonOutput({
    hookSpecificOutput: { __proto__: null, hookEventName: eventName, ...result },
  });
}

function jsonOutput(value: object): BridgeProcessResult {
  return {
    exitCode: 0,
    stdout: `${JSON.stringify(Object.assign(Object.create(null), value))}\n`,
    stderr: "",
  };
}

function permissionRequest(eventName: string, result: PermissionRequestResult): object {
  return {
    hookSpecificOutput: {
      __proto__: null,
      hookEventName: eventName,
      decision: { __proto__: null, ...result },
    },
  };
}

function topLevel(
  eventName: string,
  result: {
    readonly decision: "block";
    readonly reason: string;
    readonly additionalContext?: string;
  },
): object {
  return {
    decision: result.decision,
    reason: result.reason,
    ...(result.additionalContext === undefined
      ? {}
      : {
          hookSpecificOutput: {
            __proto__: null,
            hookEventName: eventName,
            additionalContext: result.additionalContext,
          },
        }),
  };
}

function worktree(path: string): BridgeProcessResult {
  return { exitCode: 0, stdout: `${path}\n`, stderr: "" };
}
