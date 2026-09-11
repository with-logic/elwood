/**
 * Shared hook-handler dispatch with fail-open validation for both adapters.
 * Implements PRD §6.3 (Claude) and §7A.2 (Codex): a handler is raced against
 * the hook timeout, its return value is runtime-validated for the event, and a
 * timeout, throw, rejection, or invalid value yields no decision plus a
 * categorized `hookError` (with `timeoutMs` only on a genuine timeout).
 */

import {
  activityFromHookError,
  type ElwoodActivityEvent,
  type ElwoodAgentKind,
} from "./activity/index.ts";
import { raceHookTimeout } from "./hook-timeout.ts";
import type { HookErrorEvent } from "./types.ts";

/** A hook event as dispatch sees it: its name is one the `hookError` event can carry. */
export type DispatchableHookEvent = {
  readonly hook_event_name: Exclude<HookErrorEvent["hookEventName"], "Unknown">;
};

export type HookDispatchOutcome<Result> = {
  readonly result: Result | undefined;
  readonly failedOpen: boolean;
};

/**
 * The slice of an adapter's typed emitter that dispatch needs: `hook:<name>`
 * request keys plus the `hookError`/`activity` channels. Both `TypedEmitter<ElwoodEventMap>`
 * and `TypedEmitter<CodexEventMap>` satisfy it structurally, so neither adapter
 * casts its emitter.
 */
export type HookDispatchEmitter<Event extends DispatchableHookEvent> = {
  hasListeners(event: `hook:${Event["hook_event_name"]}`): boolean;
  request(event: `hook:${Event["hook_event_name"]}`, payload: Event): Promise<unknown>;
  emit(event: "hookError", payload: HookErrorEvent): void;
  emit(event: "activity", payload: ElwoodActivityEvent): void;
};

export type HookDispatcher<Event extends DispatchableHookEvent, Result> = (
  emitter: HookDispatchEmitter<Event>,
  event: Event,
  timeoutMs: number,
  elwoodSessionId: string,
) => Promise<HookDispatchOutcome<Result>>;

/**
 * Builds an adapter's dispatcher from its agent tag (for `hook_error` activity)
 * and its per-event result validator.
 */
export function createHookDispatcher<Event extends DispatchableHookEvent, Result>(
  agent: ElwoodAgentKind,
  isValidResult: (event: Event, value: unknown) => value is Result,
): HookDispatcher<Event, Result> {
  return async (emitter, event, timeoutMs, elwoodSessionId) => {
    const failOpen = (error: Omit<HookErrorEvent, "elwoodSessionId" | "hookEventName">) => {
      const hookError = { elwoodSessionId, hookEventName: event.hook_event_name, ...error };
      emitter.emit("hookError", hookError);
      emitter.emit("activity", activityFromHookError(agent, hookError));
      return { result: undefined, failedOpen: true };
    };
    try {
      const hookName = `hook:${event.hook_event_name}` as const;
      const hasListener = emitter.hasListeners(hookName);
      const outcome = await raceHookTimeout(emitter.request(hookName, event), timeoutMs);
      if (outcome.timedOut) {
        return failOpen({
          category: "timeout",
          message: `Hook handler timed out after ${timeoutMs} ms.`,
          timeoutMs,
        });
      }
      if (!hasListener) return { result: undefined, failedOpen: false };
      if (!isValidResult(event, outcome.value)) {
        return failOpen({
          category: "invalid_response",
          message: "Hook handler returned an invalid response for this event.",
        });
      }
      return { result: outcome.value, failedOpen: false };
    } catch (error) {
      return failOpen({
        category: "handler_error",
        message: error instanceof Error ? error.message : "Hook handler failed",
      });
    }
  };
}
