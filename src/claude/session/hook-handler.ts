/**
 * The Claude hook-bridge message and error handlers that `build.ts` hands to the bridge factory,
 * for PRD §5.2, §5.3, §5.4, §6, and §8: normalize each hook, emit its `hook`/`activity`
 * events, run the caller's hook with a bounded timeout, and drive readiness/turn state — initial
 * readiness on `InstructionsLoaded` (C-API-28), turn-end on an unblocked `Stop` (C-CLAUDE-15)
 * unless Claude is about to run queued messages as a new turn (C-HOOK-24).
 */
import type { BridgeProcessResult } from "../../bridge/types.ts";
import * as activity from "../../core/activity/index.ts";
import { freezeHookEvent } from "../../core/freeze-hook-event.ts";
import { type HookObservation, hookObservationBoundary } from "../../core/hook-observation.ts";
import { subagentObservation } from "../../core/stats/subagents.ts";
import { withStopInput, withStopInputNotification } from "../../core/stop-input.ts";
import type { TurnStateWatcher } from "../../core/turn-state.ts";
import type { ClaudeEventMap, HookErrorEvent, StartClaudeOptions } from "../../core/types.ts";
import type { TypedEmitter } from "../../events/emitter.ts";
import type { InitialReady } from "../../runtime/readiness/initial-ready.ts";
import type { SessionRecord } from "../../state/store.ts";
import { isBlock, requestHook } from "../hooks/dispatch.ts";
import type { ClaudeHookEvent, ClaudeHookResult } from "../hooks/index.ts";
import { claudeTurnFailureActivity } from "../hooks/stop-failure.ts";
import { normalizeClaudeHookEvent } from "../normalize.ts";
import { claudePasteEnvelopeId, claudeSubmitPresentation } from "../pasted-content.ts";
import { serializeHookResult } from "../serialize.ts";
import type { ClaudeTranscriptWatcher } from "../transcript/index.ts";
import type { ClaudeSessionImpl } from "./instance.ts";
import { associateClaudePrompt } from "./prompt-activity.ts";
import { arriveAtStop, endUnblockedStop } from "./stop-turn.ts";
import { SubmitScreening } from "./submit-screening.ts";

/** The live pieces the Claude hook handler drives; `session`/`turnWatcher` are read
 * lazily because both are assigned after the bridge is constructed. */
export type ClaudeHookHandlerDeps = {
  readonly record: SessionRecord;
  readonly options: StartClaudeOptions;
  readonly emitter: TypedEmitter<ClaudeEventMap>;
  readonly transcriptWatcher: Pick<
    ClaudeTranscriptWatcher,
    "scan" | "scanPath" | "observeUserPromptHook" | "queuedPrompts"
  >;
  readonly ready: InitialReady;
  readonly getSession: () => ClaudeSessionImpl | undefined;
  readonly getTurnWatcher: () => TurnStateWatcher;
  readonly observeHookTranscript: (event: ClaudeHookEvent) => void;
  readonly onHookOutcome?: (event: ClaudeHookEvent, result: ClaudeHookResult) => void;
};

/** Builds the async hook-message handler passed to the Claude hook bridge factory. */
export function buildClaudeHookHandler(
  deps: ClaudeHookHandlerDeps,
): (input: unknown) => Promise<BridgeProcessResult> {
  const { record, options, emitter, transcriptWatcher, ready } = deps;
  const screening = new SubmitScreening();
  return async (input: unknown): Promise<BridgeProcessResult> => {
    const event = freezeHookEvent(normalizeClaudeHookEvent(input));
    return await withStopInput(
      { hookName: event.hook_event_name, session: deps.getSession() ?? record },
      () => observeAndRequest(event),
    );
  };
  function publish(event: ClaudeHookEvent, observation: HookObservation): void {
    const native = activity.activityFromClaudeHook(record.elwoodSessionId, event);
    const observe = () => observation.run("transcript", () => deps.observeHookTranscript(event));
    const submit = event.hook_event_name === "UserPromptSubmit";
    const pasteEnvelopeId = submit ? claudePasteEnvelopeId(event.session_id) : undefined;
    const projected =
      native.kind === "user_message"
        ? {
            ...native,
            agent: "claude" as const,
            ...claudeSubmitPresentation(event, native.text, pasteEnvelopeId),
          }
        : native;
    const hasText = projected.kind === "user_message";
    const turnId = projected.turnId;
    let show = true;
    const note = () =>
      observation.run("transcript", () => {
        if (submit && turnId !== undefined) {
          const emitHookMessage = transcriptWatcher.observeUserPromptHook({
            path: event.transcript_path,
            turnId,
            hasText,
            prompt: event.prompt,
            pasteEnvelopeId,
          });
          if (hasText) show = emitHookMessage;
        }
      });
    // Register nonblank text before scanning so its transcript copy stays deduplicated.
    // Publish a blank native submit first because recording its ID can immediately recover text.
    const recoverAfterHook = submit && !hasText;
    if (!recoverAfterHook) note();
    const output = submit
      ? associateClaudePrompt(deps.getSession()?.promptSubmissions, event, projected, show)
      : projected;
    // Transcript scans can notify the host synchronously. Associate before it can take input.
    if (!recoverAfterHook) observe();
    observation.run("hook", () => emitter.emit("hook", event));
    if (show) observation.run("activity", () => emitter.emit("activity", output));
    if (event.hook_event_name === "StopFailure")
      observation.run("activity", () =>
        emitter.emit("activity", claudeTurnFailureActivity(record.elwoodSessionId, event)),
      );
    if (recoverAfterHook) {
      note();
      observe();
    }
  }

  async function observeAndRequest(event: ClaudeHookEvent): Promise<BridgeProcessResult> {
    // What may start another turn counts from here, before any listener hears of the `Stop`.
    const stop =
      event.hook_event_name === "Stop" ? arriveAtStop(deps.getSession(), screening) : undefined;
    const observation = hookObservationBoundary(emitter, record.elwoodSessionId, "claude");
    const queued = transcriptWatcher.queuedPrompts();
    const queuedPromptPosition = queued?.nextPosition;
    publish(event, observation);
    // Claude runs a submitted message only once the caller's handler allows it (C-HOOK-24).
    const settleSubmit =
      event.hook_event_name === "UserPromptSubmit"
        ? screening.begin(queued, queuedPromptPosition, event.prompt)
        : undefined;
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
    const blocked = isBlock(outcome.result);
    settleSubmit?.(blocked);
    const serialized = serializeHookResult(event.hook_event_name, outcome.result);
    // Claude can emit SessionStart before a conversation transcript exists.
    // Persist its native resume ID after an unblocked UserPromptSubmit (C-CLAUDE-08).
    if (event.hook_event_name === "UserPromptSubmit" && !blocked)
      observation.run("lifecycle", () =>
        deps.getSession()?.rememberClaudeSessionId(event.session_id),
      );
    observation.run("activity", () =>
      emitter.emit(
        "activity",
        activity.activityFromHookResult(
          "claude",
          record.elwoodSessionId,
          event.hook_event_name,
          outcome.result,
          outcome.failedOpen,
          subagentObservation(event, blocked, deps.getSession()?.closing.signal),
        ),
      ),
    );
    observation.run("activity", () => deps.onHookOutcome?.(event, outcome.result));
    if (event.hook_event_name === "InstructionsLoaded")
      observation.run("lifecycle", () => ready.mark());
    if (stop && !blocked)
      endUnblockedStop({
        arrival: stop,
        transcriptWatcher,
        transcriptPath: event.transcript_path,
        observation,
        screening,
        getSession: deps.getSession,
        getTurnWatcher: deps.getTurnWatcher,
      });
    else stop?.release();
    observation.report();
    return serialized;
  }
}

/** Builds the hook-error handler passed to the Claude hook bridge factory. */
export function buildClaudeHookErrorHandler(
  record: SessionRecord,
  emitter: TypedEmitter<ClaudeEventMap>,
  getSession?: () => ClaudeSessionImpl | undefined,
): (event: Omit<HookErrorEvent, "elwoodSessionId">) => void {
  return (event) =>
    withStopInputNotification(
      { hookName: event.hookEventName, session: getSession?.() ?? record },
      () => {
        const hookError = { elwoodSessionId: record.elwoodSessionId, ...event };
        const observation = hookObservationBoundary(emitter, record.elwoodSessionId, "claude");
        observation.run("hook_error", () => emitter.emit("hookError", hookError));
        observation.run("activity", () =>
          emitter.emit("activity", activity.activityFromHookError("claude", hookError)),
        );
        observation.report();
      },
    );
}
