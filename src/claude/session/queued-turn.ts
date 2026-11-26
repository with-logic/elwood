/**
 * Claude Code 2.1.332 runs every message still queued at a turn's `Stop` as one new turn right
 * away, so that `Stop` must not mark the session ready (PRD §6.5, C-HOOK-24). Claude writes a
 * `queue-operation` `dequeue` record per message 74 to 340 ms after the `Stop` (measured), then a
 * `queued` user record per message. Once both are read, the queued turn's prompt ID is known and
 * its own `Stop` marks readiness. Claude runs a message only once the caller's `UserPromptSubmit`
 * handler allows it, so the bound starts when no handler is screening, and a `Stop` whose messages
 * were all blocked ends the turn then. Messages that still lack a `queued` record at the bound,
 * after a `dequeue`, are forgotten and leave readiness to that turn's `Stop`. Without a `dequeue`
 * by the bound, read to the transcript's end, Claude did not run them: they are forgotten, and
 * this `Stop` warns and marks readiness unless something else ended its turn or started another.
 */
import type { HookObservation } from "../../core/hook-observation.ts";
import { outsideStopInput } from "../../core/stop-input.ts";
import { deadlineClock } from "../../core/timers.ts";
import type { TurnStateWatcher } from "../../core/turn-state.ts";
import type { ClaudeQueuedTurnUnconfirmedWarning } from "../../core/warnings/lifecycle.ts";
import { onCallerInput } from "../../runtime/session/session-input.ts";
import type { ClaudeTranscriptWatcher } from "../transcript/index.ts";
import type { ClaudeSessionImpl } from "./instance.ts";
import type { SubmitScreening } from "./submit-screening.ts";

/** Longest a `Stop` with queued messages waits for Claude to start their turn (C-HOOK-24). */
export const queuedTurnStartLimitMs = 2_000;
/** Below the earliest measured `dequeue`, so the queued turn's records are read promptly. */
const pollIntervalMs = 50;
/** One 256 KiB chunk per poll, so a transcript backlog drains without long event-loop blocks. */
const pollScanChunks = 1;
/**
 * Claude stamps a `dequeue` after it receives the `Stop`'s response. The allowance absorbs a stamp
 * truncated to the second or a clock step, and is far shorter than an earlier queued turn.
 */
const dequeueStampAllowanceMs = 1_000;

type QueuedTurnEvidence = Pick<ClaudeTranscriptWatcher, "scan" | "queuedPrompts">;

export type QueuedTurnEnd = {
  /** Nothing ended this turn since its `Stop`, and nothing newer started another. */
  readonly ownsTurnEnd: () => boolean;
  /** Whether the caller's handler is still screening a submitted message. */
  readonly screening: () => boolean;
  /** Ends the turn, first emitting `queued_turn_unconfirmed` when Claude was not seen to start it. */
  readonly endTurn: (unconfirmed: boolean) => void;
  /** Called once, when the hold stops waiting. */
  readonly release: () => void;
  readonly closing: AbortSignal;
  /** The `Stop`'s own boundary, so one invocation warns of listener failures once (C-HOOK-22). */
  readonly observation: Pick<HookObservation, "run">;
};

/** Returns whether this `Stop` waits for the queued turn instead of marking readiness now. */
export function holdForQueuedTurn(evidence: QueuedTurnEvidence, end: QueuedTurnEnd): boolean {
  const queued = evidence.queuedPrompts();
  if (queued === undefined) return false;
  const window = queued.takeStopWindow();
  if (!queued.hasPendingIn(window)) {
    // Blocked messages never run, and earlier messages belong to an earlier `Stop`.
    queued.forgetBefore(window.to);
    return false;
  }
  const stoppedAt = Date.now() - dequeueStampAllowanceMs;
  let deadlineAt = deadlineClock.now() + queuedTurnStartLimitMs;
  // Polls outlive the `Stop` callback, so they must not inherit its closed input context (C-HOOK-04).
  const schedule = () => void outsideStopInput(() => setTimeout(poll, pollIntervalMs)).unref();
  const finish = (unconfirmed: boolean | undefined): void => {
    queued.forgetBefore(window.to);
    if (unconfirmed !== undefined && end.ownsTurnEnd())
      end.observation.run("lifecycle", () => end.endTurn(unconfirmed));
    end.release();
  };
  const poll = (): void => {
    if (end.closing.aborted) {
      end.release();
      return;
    }
    let behind = false;
    end.observation.run("transcript", () => {
      behind = !evidence.scan(pollScanChunks);
    });
    const started = queued.dequeuedSince(stoppedAt);
    const pending = queued.hasPendingIn(window);
    // Claude started the queued turn, and its `queued` records named its prompt ID.
    if (started && !pending) {
      end.release();
      return;
    }
    if (end.screening()) deadlineAt = deadlineClock.now() + queuedTurnStartLimitMs;
    // Claude runs none of the messages: every one was blocked.
    else if (!(started || pending)) {
      finish(false);
      return;
    }
    if (behind || deadlineClock.now() < deadlineAt) {
      schedule();
      return;
    }
    // A queued turn that started ends at its own `Stop`.
    finish(started ? undefined : true);
  };
  schedule();
  return true;
}

export type ClaudeStopTurn = {
  readonly session: Pick<
    ClaudeSessionImpl,
    "elwoodSessionId" | "submitEvidence" | "status" | "statusDecisions" | "closing" | "emitWarnings"
  > & { readonly terminal: Parameters<typeof onCallerInput>[0] };
  readonly transcriptWatcher: QueuedTurnEvidence;
  readonly observation: Pick<HookObservation, "run">;
  readonly submissionGenerationUnchanged: () => boolean;
  readonly screening: Pick<SubmitScreening, "active" | "mark" | "allowedSince">;
};

/** Ends the turn an unblocked, unsuperseded `Stop` reports, unless Claude may run queued messages. */
export function endTurnUnlessQueued(stop: ClaudeStopTurn): void {
  const { session, observation, screening } = stop;
  const submitHookTurnEnded = () => void session.submitEvidence("hook_turn_ended");
  const statusUnchanged = statusUnchangedSinceNow(session);
  const submitsAtStop = screening.mark();
  let callerTyped = false;
  const stopWatchingInput = onCallerInput(session.terminal, () => {
    callerTyped = true;
  });
  const held = holdForQueuedTurn(stop.transcriptWatcher, {
    // Ending a turn the screen already ended would warn falsely and re-arm a released turn-end
    // hold. A turn that raw input, a later caller submission, or Claude itself started since, for
    // a submit the handler allowed, is not this `Stop`'s turn.
    ownsTurnEnd: () =>
      stop.submissionGenerationUnchanged() &&
      !callerTyped &&
      !screening.allowedSince(submitsAtStop) &&
      session.status === "running" &&
      statusUnchanged(),
    screening: () => screening.active,
    endTurn: (unconfirmed) => {
      if (unconfirmed)
        session.emitWarnings([queuedTurnUnconfirmedWarning(session.elwoodSessionId)]);
      submitHookTurnEnded();
    },
    release: stopWatchingInput,
    closing: session.closing.signal,
    observation,
  });
  if (held) return;
  stopWatchingInput();
  observation.run("lifecycle", submitHookTurnEnded);
}

/** After an unblocked `Stop`: ends its turn unless a newer submission or a queued turn supersedes it. */
export function endUnblockedStop(
  stop: Omit<ClaudeStopTurn, "session" | "observation"> & {
    readonly observation: HookObservation;
    readonly getSession: () => ClaudeStopTurn["session"] | undefined;
    readonly getTurnWatcher: () => Pick<TurnStateWatcher, "arm">;
  },
): void {
  stop.observation.run("transcript", () => stop.transcriptWatcher.scan());
  // Diagnostic callbacks may submit input; report before comparing physical generations.
  stop.observation.report();
  // Guidance may steer the current turn; every physical submission supersedes this Stop.
  const session = stop.getSession();
  if (!stop.submissionGenerationUnchanged()) return;
  stop.getTurnWatcher().arm();
  if (session) endTurnUnlessQueued({ ...stop, session });
}

/** Whether no status transition was applied after now. An evicted entry counts as a change. */
function statusUnchangedSinceNow(session: Pick<ClaudeSessionImpl, "statusDecisions">) {
  const latest = session.statusDecisions().at(-1);
  return (): boolean => {
    const decisions = session.statusDecisions();
    const index = latest === undefined ? -1 : decisions.lastIndexOf(latest);
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
    message: `Elwood saw no sign, ${queuedTurnStartLimitMs / 1000} seconds after Claude's Stop and any screening of queued messages, that Claude started a turn for them, so it is ending the turn.`,
    raw: "queued_turn_unconfirmed",
  };
}
