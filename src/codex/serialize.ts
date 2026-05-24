/**
 * Converts typed hook handler results to Codex hook process output.
 * Implements PRD §7A.2.
 */

import type { BridgeProcessResult } from "../bridge/types.ts";
import type { CodexHookEventName, CodexHookResult } from "./hooks.ts";

export function serializeCodexHookResult(
  eventName: CodexHookEventName,
  result: CodexHookResult,
): BridgeProcessResult {
  if (result === undefined) return { exitCode: 0, stdout: "", stderr: "" };
  if ("permissionDecision" in result)
    return jsonOutput({ hookSpecificOutput: named(eventName, result) });
  if ("behavior" in result) return jsonOutput(permissionRequest(eventName, result));
  if ("decision" in result) return jsonOutput(block(eventName, result));
  return jsonOutput(common(eventName, result));
}

function jsonOutput(value: unknown): BridgeProcessResult {
  return { exitCode: 0, stdout: `${JSON.stringify(value)}\n`, stderr: "" };
}

function named(eventName: string, result: Readonly<Record<string, unknown>>): unknown {
  return { hookEventName: eventName, ...result };
}

function permissionRequest(
  eventName: string,
  result: { readonly behavior: "allow" | "deny"; readonly message?: string },
): unknown {
  return { hookSpecificOutput: { hookEventName: eventName, ...result } };
}

function block(
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

function common(eventName: string, result: Readonly<Record<string, unknown>>): unknown {
  const { additionalContext, ...commonFields } = result;
  return {
    ...commonFields,
    ...(typeof additionalContext === "string"
      ? { hookSpecificOutput: { hookEventName: eventName, additionalContext } }
      : {}),
  };
}
