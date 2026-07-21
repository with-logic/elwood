/**
 * Hook handler dispatch and fail-open validation.
 * Implements PRD §4.1, §6, and §8.
 */

import { activityFromHookError } from "../core/activity.ts";
import { raceHookTimeout } from "../core/hook-timeout.ts";
import type { ElwoodEventName, HookErrorEvent } from "../core/types.ts";
import type { TypedEmitter } from "../events/emitter.ts";
import type { ClaudeHookEvent, ClaudeHookResult } from "./hooks.ts";
import { isClaudeHookResult } from "./validate-result.ts";

export type HookDispatchOutcome = {
  readonly result: ClaudeHookResult;
  readonly failedOpen: boolean;
};

export async function requestHook(
  emitter: TypedEmitter,
  event: ClaudeHookEvent,
  timeoutMs: number,
  elwoodSessionId: string,
): Promise<HookDispatchOutcome> {
  try {
    const hookName = `hook:${event.hook_event_name}` as ElwoodEventName;
    const hasListener = emitter.hasListeners(hookName);
    const outcome = await raceHookTimeout(emitter.request(hookName, event), timeoutMs);
    if (outcome.timedOut) {
      emitHookError(emitter, {
        elwoodSessionId,
        hookEventName: event.hook_event_name,
        category: "timeout",
        message: `Hook handler timed out after ${timeoutMs} ms.`,
        timeoutMs,
      });
      return { result: undefined, failedOpen: true };
    }
    if (!hasListener) return { result: undefined, failedOpen: false };
    if (!isClaudeHookResult(event, outcome.value)) {
      emitHookError(emitter, {
        elwoodSessionId,
        hookEventName: event.hook_event_name,
        category: "invalid_response",
        message: "Hook handler returned an invalid response for this event.",
      });
      return { result: undefined, failedOpen: true };
    }
    return { result: outcome.value, failedOpen: false };
  } catch (error) {
    emitHookError(emitter, {
      elwoodSessionId,
      hookEventName: event.hook_event_name,
      category: "handler_error",
      message: error instanceof Error ? error.message : "Hook handler failed",
    });
    return { result: undefined, failedOpen: true };
  }
}

export function isBlock(result: ClaudeHookResult): boolean {
  return Boolean(result && "decision" in result && result.decision === "block");
}

function emitHookError(emitter: TypedEmitter, event: HookErrorEvent): void {
  emitter.emit("hookError", event);
  emitter.emit("activity", activityFromHookError("claude", event));
}
