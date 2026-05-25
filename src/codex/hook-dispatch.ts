/**
 * Codex hook handler dispatch and fail-open validation.
 * Implements PRD §7A.
 */

import { activityFromHookError } from "../core/activity.ts";
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
    const result = await withTimeout(
      (
        emitter as unknown as { request: (name: string, payload: unknown) => Promise<unknown> }
      ).request(`hook:${event.hook_event_name}`, event),
      timeoutMs,
    );
    if (!isCodexHookResult(event.hook_event_name, result)) {
      emitError(emitter, {
        elwoodSessionId,
        hookEventName: event.hook_event_name,
        category: "invalid_response",
        message: "Hook handler returned an invalid response for this event.",
      });
      return { result: undefined, failedOpen: true };
    }
    return { result, failedOpen: false };
  } catch (error) {
    emitError(emitter, {
      elwoodSessionId,
      hookEventName: event.hook_event_name,
      category: error instanceof Error && error.message === "timeout" ? "timeout" : "handler_error",
      message: error instanceof Error ? error.message : "Hook handler failed",
      timeoutMs,
    });
    return { result: undefined, failedOpen: true };
  }
}

export function isCodexBlock(result: CodexHookResult): boolean {
  return Boolean(result && "decision" in result && result.decision === "block");
}

function emitError(emitter: TypedEmitter<CodexEventMap>, event: HookErrorEvent): void {
  emitter.emit("hookError", event);
  emitter.emit("activity", activityFromHookError("codex", event));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: Timer | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error("timeout")), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
