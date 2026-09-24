/**
 * The Claude hook-bridge message and error handlers that `build.ts` hands
 * to the bridge factory. Implements PRD §5.3, §5.4, §6, and §8:
 * normalize each hook, emit its `hook`/`activity` events, run the caller's hook
 * with a bounded timeout, and drive readiness/turn state — initial readiness on
 * `InstructionsLoaded` (C-API-28), turn-end on an unblocked `Stop` (C-CLAUDE-15).
 */

import type { BridgeProcessResult } from "../../bridge/types.ts";
import * as activity from "../../core/activity/index.ts";
import type { TurnStateWatcher } from "../../core/turn-state.ts";
import type { ClaudeEventMap, HookErrorEvent, StartClaudeOptions } from "../../core/types.ts";
import type { TypedEmitter } from "../../events/emitter.ts";
import type { InitialReady } from "../../runtime/readiness/initial-ready.ts";
import type { SessionRecord } from "../../state/store.ts";
import { isBlock, requestHook } from "../hooks/dispatch.ts";
import type { ClaudeHookEvent } from "../hooks/index.ts";
import { normalizeClaudeHookEvent } from "../normalize.ts";
import { serializeHookResult } from "../serialize.ts";
import { freezeHookEvent } from "./freeze-hook-event.ts";
import { hookObservationBoundary } from "./hook-observation.ts";
import type { ClaudeSessionImpl } from "./instance.ts";

/** The live pieces the Claude hook handler drives; `session`/`turnWatcher` are read
 * lazily because both are assigned after the bridge is constructed. */
export type ClaudeHookHandlerDeps = {
  readonly record: SessionRecord;
  readonly options: StartClaudeOptions;
  readonly emitter: TypedEmitter<ClaudeEventMap>;
  readonly transcriptWatcher: { readonly scan: () => void };
  readonly ready: InitialReady;
  readonly getSession: () => ClaudeSessionImpl | undefined;
  readonly getTurnWatcher: () => TurnStateWatcher;
  readonly observeHookTranscript: (event: ClaudeHookEvent) => void;
};

/** Builds the async hook-message handler passed to the Claude hook bridge factory. */
export function buildClaudeHookHandler(
  deps: ClaudeHookHandlerDeps,
): (input: unknown) => Promise<BridgeProcessResult> {
  const { record, options, emitter, transcriptWatcher, ready } = deps;
  return async (input: unknown): Promise<BridgeProcessResult> => {
    const event = freezeHookEvent(normalizeClaudeHookEvent(input));
    const currentSubmission =
      event.hook_event_name === "Stop"
        ? deps.getSession()?.stopCompletion.captureCurrentSubmission()
        : undefined;
    const observation = hookObservationBoundary(emitter, record.elwoodSessionId);
    if (event.hook_event_name === "SessionStart")
      deps.getSession()?.rememberClaudeSessionId(event.session_id);
    observation.run("transcript", () => deps.observeHookTranscript(event));
    observation.run("hook", () => emitter.emit("hook", event));
    observation.run("activity", () =>
      emitter.emit("activity", activity.activityFromClaudeHook(record.elwoodSessionId, event)),
    );
    const outcome = await requestHook(
      {
        hasListeners: (name) => emitter.hasListeners(name),
        requestWithProvenance: (name, payload) => emitter.requestWithProvenance(name, payload),
        emit: (name, payload) =>
          observation.run(name === "hookError" ? "hook_error" : "activity", () =>
            emitter.emit(name, payload),
          ),
      },
      event,
      options.hookTimeoutMs ?? 25_000,
      record.elwoodSessionId,
    );
    const serialized = serializeHookResult(event.hook_event_name, outcome.result);
    const blocked = isBlock(outcome.result);
    observation.run("activity", () =>
      emitter.emit(
        "activity",
        activity.activityFromHookResult(
          "claude",
          record.elwoodSessionId,
          event.hook_event_name,
          outcome.result,
          outcome.failedOpen,
        ),
      ),
    );
    if (event.hook_event_name === "InstructionsLoaded")
      observation.run("lifecycle", () => ready.mark());
    if (event.hook_event_name === "Stop" && !blocked) {
      observation.run("transcript", () => transcriptWatcher.scan());
      if (currentSubmission?.() !== false) {
        deps.getTurnWatcher().arm();
        observation.run("lifecycle", () => deps.getSession()?.submitEvidence("hook_turn_ended"));
      }
    }
    observation.report();
    return serialized;
  };
}

/** Builds the hook-error handler passed to the Claude hook bridge factory. */
export function buildClaudeHookErrorHandler(
  record: SessionRecord,
  emitter: TypedEmitter<ClaudeEventMap>,
): (event: Omit<HookErrorEvent, "elwoodSessionId">) => void {
  return (event) => {
    const hookError = { elwoodSessionId: record.elwoodSessionId, ...event };
    const observation = hookObservationBoundary(emitter, record.elwoodSessionId);
    observation.run("hook_error", () => emitter.emit("hookError", hookError));
    observation.run("activity", () =>
      emitter.emit("activity", activity.activityFromHookError("claude", hookError)),
    );
    observation.report();
  };
}
