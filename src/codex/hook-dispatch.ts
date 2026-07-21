/**
 * Codex hook handler dispatch and fail-open validation.
 * Implements PRD §7A.
 */

import { activityFromHookError } from "../core/activity.ts";
import { raceHookTimeout } from "../core/hook-timeout.ts";
import type { HookErrorEvent } from "../core/types.ts";
import type { TypedEmitter } from "../events/emitter.ts";
import type { CodexHookEvent, CodexHookResult } from "./hooks.ts";
import type { CodexEventMap } from "./session-types.ts";
import { isCodexHookResult } from "./validate.ts";

export type CodexHookDispatchOutcome = {
  readonly result: CodexHookResult;
  readonly failedOpen: boolean;
};

export async function requestCodexHook(
  emitter: TypedEmitter<CodexEventMap>,
  event: CodexHookEvent,
  timeoutMs: number,
  elwoodSessionId: string,
): Promise<CodexHookDispatchOutcome> {
  try {
    const hookName = `hook:${event.hook_event_name}`;
    const requestable = emitter as unknown as {
      hasListeners: (name: string) => boolean;
      request: (name: string, payload: unknown) => Promise<unknown>;
    };
    const hasListener = requestable.hasListeners(hookName);
    const outcome = await raceHookTimeout(requestable.request(hookName, event), timeoutMs);
    if (outcome.timedOut) {
      emitError(emitter, {
        elwoodSessionId,
        hookEventName: event.hook_event_name,
        category: "timeout",
        message: `Hook handler timed out after ${timeoutMs} ms.`,
        timeoutMs,
      });
      return { result: undefined, failedOpen: true };
    }
    if (!hasListener) return { result: undefined, failedOpen: false };
    if (!isCodexHookResult(event, outcome.value)) {
      emitError(emitter, {
        elwoodSessionId,
        hookEventName: event.hook_event_name,
        category: "invalid_response",
        message: "Hook handler returned an invalid response for this event.",
      });
      return { result: undefined, failedOpen: true };
    }
    return { result: outcome.value, failedOpen: false };
  } catch (error) {
    emitError(emitter, {
      elwoodSessionId,
      hookEventName: event.hook_event_name,
      category: "handler_error",
      message: error instanceof Error ? error.message : "Hook handler failed",
    });
    return { result: undefined, failedOpen: true };
  }
}

export function isCodexBlock(result: CodexHookResult): boolean {
  return Boolean(
    result &&
      (("decision" in result && result.decision === "block") ||
        ("continue" in result && result.continue === false)),
  );
}

function emitError(emitter: TypedEmitter<CodexEventMap>, event: HookErrorEvent): void {
  emitter.emit("hookError", event);
  emitter.emit("activity", activityFromHookError("codex", event));
}
