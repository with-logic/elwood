/**
 * How an unblocked Claude `Stop` ends its turn (PRD §6.5, C-HOOK-24, C-HOOK-22). Another turn may
 * start from the moment the `Stop` arrives, before any listener hears of it: a newer caller
 * submission, raw caller input, or a `UserPromptSubmit` the caller's handler allowed. A `Stop`
 * whose queued messages Claude may run holds instead of marking readiness (`queued-turn.ts`).
 */
import type { HookObservation } from "../../core/hook-observation.ts";
import type { TurnStateWatcher } from "../../core/turn-state.ts";
import type { ClaudeQueuedTurnUnconfirmedWarning } from "../../core/warnings/lifecycle.ts";
import { onCallerInput } from "../../runtime/session/session-input.ts";
import type { StopCompletion } from "../../runtime/session/stop-completion.ts";
import type { ClaudeTranscriptWatcher } from "../transcript/index.ts";
import type { ClaudeSessionImpl } from "./instance.ts";
import { holdForQueuedTurn, type QueuedTurnEvidence } from "./queued-turn.ts";
import type { SubmitScreening } from "./submit-screening.ts";

/** What a `Stop` records as it arrives. `release` stops watching caller input. */
export type StopArrival = {
  readonly submissionGenerationUnchanged: () => boolean;
  /** No newer caller submission, raw caller input, or allowed `UserPromptSubmit` since arrival. */
  readonly nothingStartedSince: () => boolean;
  readonly release: () => void;
};

/** Called as a `Stop` arrives, before its hook or activity reaches any listener. */
export function arriveAtStop(
  session:
    | {
        readonly stopCompletion: Pick<StopCompletion, "captureSubmissionGeneration">;
        readonly terminal: Parameters<typeof onCallerInput>[0];
      }
    | undefined,
  screening: Pick<SubmitScreening, "mark" | "allowedSince">,
): StopArrival {
  const submissionGenerationUnchanged =
    session?.stopCompletion.captureSubmissionGeneration() ?? (() => true);
  const submitsAtArrival = screening.mark();
  let callerInputReceived = false;
  const noteInput = () => {
    callerInputReceived = true;
  };
  return {
    submissionGenerationUnchanged,
    nothingStartedSince: () =>
      submissionGenerationUnchanged() &&
      !callerInputReceived &&
      !screening.allowedSince(submitsAtArrival),
    release: session ? onCallerInput(session.terminal, noteInput) : () => undefined,
  };
}

export type ClaudeStopTurn = QueuedTurnEvidence & {
  readonly session: Pick<
    ClaudeSessionImpl,
    "elwoodSessionId" | "submitEvidence" | "status" | "statusDecisions" | "closing" | "emitWarnings"
  >;
  readonly arrival: StopArrival;
  readonly observation: Pick<HookObservation, "run">;
  readonly screening: Pick<SubmitScreening, "active">;
};

/**
 * Ends the turn an unblocked, unsuperseded `Stop` reports, unless Claude may run queued messages.
 * Returns whether the `Stop` holds for them.
 */
export function endTurnUnlessQueued(stop: ClaudeStopTurn): boolean {
  const { session, observation, arrival } = stop;
  const submitHookTurnEnded = () => void session.submitEvidence("hook_turn_ended");
  const statusUnchanged = statusUnchangedSinceNow(session);
  // Ending a turn the screen already ended would warn falsely and re-arm a released turn-end hold.
  // A turn started since the `Stop` arrived is not this `Stop`'s turn.
  const ownsTurnEnd = () =>
    arrival.nothingStartedSince() && session.status === "running" && statusUnchanged();
  const held = holdForQueuedTurn(stop, {
    ownsTurnEnd,
    screening: () => stop.screening.active,
    endTurn: (unconfirmed) => {
      if (unconfirmed)
        session.emitWarnings([queuedTurnUnconfirmedWarning(session.elwoodSessionId)]);
      // A warning listener may have written input or submitted since the hold checked.
      if (ownsTurnEnd()) submitHookTurnEnded();
    },
    release: arrival.release,
    closing: session.closing.signal,
    observation,
  });
  if (held) return true;
  arrival.release();
  observation.run("lifecycle", submitHookTurnEnded);
  return false;
}

/** After an unblocked `Stop`: ends its turn unless a newer submission or a queued turn supersedes it. */
export function endUnblockedStop(
  stop: Omit<ClaudeStopTurn, "session" | "observation" | "transcriptWatcher"> & {
    readonly transcriptWatcher: Pick<
      ClaudeTranscriptWatcher,
      "scan" | "scanPath" | "queuedPrompts"
    >;
    readonly observation: HookObservation;
    readonly getSession: () => ClaudeStopTurn["session"] | undefined;
    readonly getTurnWatcher: () => Pick<TurnStateWatcher, "arm" | "endedByHook">;
  },
): void {
  stop.observation.run("transcript", () => stop.transcriptWatcher.scan());
  // Diagnostic callbacks may submit input; report before comparing physical generations.
  stop.observation.report();
  // Guidance may steer the current turn; every physical submission supersedes this Stop.
  const session = stop.getSession();
  if (!stop.arrival.submissionGenerationUnchanged()) {
    stop.arrival.release();
    return;
  }
  const turnWatcher = stop.getTurnWatcher();
  turnWatcher.arm();
  // Claude's composer idles while a handler screens a held message: that is not a turn's end.
  if (session === undefined) stop.arrival.release();
  else if (endTurnUnlessQueued({ ...stop, session })) turnWatcher.endedByHook();
}

/** Whether no status transition was applied after now. An evicted entry counts as a change. */
function statusUnchangedSinceNow(session: Pick<ClaudeSessionImpl, "statusDecisions">) {
  const latest = session.statusDecisions().at(-1);
  return (): boolean => {
    const decisions = session.statusDecisions();
    const index = decisions.findLastIndex((decision) => decision === latest);
    return index >= 0 && decisions.slice(index + 1).every((decision) => decision.to === undefined);
  };
}

function queuedTurnUnconfirmedWarning(elwoodSessionId: string): ClaudeQueuedTurnUnconfirmedWarning {
  return {
    elwoodSessionId,
    agent: "claude",
    source: "lifecycle",
    code: "queued_turn_unconfirmed",
    severity: "warning",
    message:
      "Elwood could not confirm that Claude started a turn for the messages queued at its Stop, so it is ending the turn.",
    raw: "queued_turn_unconfirmed",
  };
}
