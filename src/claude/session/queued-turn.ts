/**
 * Claude Code 2.1.332 runs every message still queued at a turn's `Stop` as one new turn right
 * away, so that `Stop` must not mark the session ready (PRD §6.5, C-HOOK-24). Claude writes a
 * `queue-operation` `dequeue` record per message 74 to 340 ms after the `Stop` (measured), then a
 * `queued` user record per message. Once both are read, the queued turn's prompt ID is known and
 * its own `Stop` marks readiness. Messages pending at the `Stop` that still lack a `queued` record
 * at the bound, after a `dequeue`, are forgotten and leave readiness to that turn's `Stop`. Without
 * a `dequeue` within the bound, Claude did not run the messages: they are forgotten, and this `Stop`
 * warns and marks readiness unless the status changed since or a newer submission superseded it.
 */
import type { HookObservation } from "../../core/hook-observation.ts";
import { outsideStopInput } from "../../core/stop-input.ts";
import { deadlineClock } from "../../core/timers.ts";
import type { ClaudeQueuedTurnUnconfirmedWarning } from "../../core/warnings/lifecycle.ts";
import type { ClaudeTranscriptWatcher } from "../transcript/index.ts";
import type { ClaudeSessionImpl } from "./instance.ts";

/** Longest a `Stop` with queued messages waits for Claude to start their turn (C-HOOK-24). */
export const queuedTurnStartLimitMs = 2_000;
/** Below the earliest measured `dequeue`, so the queued turn's records are read promptly. */
const pollIntervalMs = 50;

type QueuedTurnEvidence = Pick<ClaudeTranscriptWatcher, "scan" | "queuedPrompts">;

export type QueuedTurnEnd = {
  /** Nothing ended this turn since its `Stop`, and no newer physical submission superseded it. */
  readonly ownsTurnEnd: () => boolean;
  /** Emits `queued_turn_unconfirmed`, then ends the turn. */
  readonly endUnconfirmedTurn: () => void;
  readonly closing: AbortSignal;
  /** The `Stop`'s own boundary, so one invocation warns of listener failures once (C-HOOK-22). */
  readonly observation: Pick<HookObservation, "run">;
};

/** Returns whether this `Stop` waits for the queued turn instead of marking readiness now. */
export function holdForQueuedTurn(evidence: QueuedTurnEvidence, end: QueuedTurnEnd): boolean {
  const queued = evidence.queuedPrompts();
  if (queued === undefined) return false;
  const window = queued.stopWindow();
  if (!queued.hasPendingIn(window)) {
    // Blocked messages never run, and earlier messages belong to an earlier `Stop`.
    queued.forgetBefore(window.to);
    return false;
  }
  const dequeuesAtStop = queued.dequeueCount;
  const deadlineAt = deadlineClock.now() + queuedTurnStartLimitMs;
  // Polls outlive the `Stop` callback, so they must not inherit its closed input context (C-HOOK-04).
  const schedule = () => void outsideStopInput(() => setTimeout(poll, pollIntervalMs)).unref();
  const poll = (): void => {
    if (end.closing.aborted) return;
    end.observation.run("transcript", () => evidence.scan());
    const started = queued.dequeueCount > dequeuesAtStop;
    // Claude started the queued turn: wait for its `queued` records, which name its prompt ID.
    if (started && !queued.hasPendingIn(window)) return;
    if (deadlineClock.now() < deadlineAt) {
      schedule();
      return;
    }
    queued.forgetBefore(window.to);
    // A queued turn that started ends at its own `Stop`.
    if (!started && end.ownsTurnEnd()) end.observation.run("lifecycle", end.endUnconfirmedTurn);
  };
  schedule();
  return true;
}

export type ClaudeStopTurn = {
  readonly session: Pick<
    ClaudeSessionImpl,
    "elwoodSessionId" | "submitEvidence" | "status" | "statusDecisions" | "closing" | "emitWarnings"
  >;
  readonly transcriptWatcher: QueuedTurnEvidence;
  readonly observation: Pick<HookObservation, "run">;
  readonly submissionGenerationUnchanged: () => boolean;
};

/** Ends the turn an unblocked, unsuperseded `Stop` reports, unless Claude may run queued messages. */
export function endTurnUnlessQueued(stop: ClaudeStopTurn): void {
  const { session, observation } = stop;
  const submitHookTurnEnded = () => void session.submitEvidence("hook_turn_ended");
  const statusUnchanged = statusUnchangedSinceNow(session);
  const held = holdForQueuedTurn(stop.transcriptWatcher, {
    // Ending a turn the screen already ended would warn falsely and re-arm a released turn-end
    // hold; a turn started since, by raw input, is not this `Stop`'s turn.
    ownsTurnEnd: () =>
      stop.submissionGenerationUnchanged() && session.status === "running" && statusUnchanged(),
    endUnconfirmedTurn: () => {
      session.emitWarnings([queuedTurnUnconfirmedWarning(session.elwoodSessionId)]);
      submitHookTurnEnded();
    },
    closing: session.closing.signal,
    observation,
  });
  if (!held) observation.run("lifecycle", submitHookTurnEnded);
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
    message: `Elwood saw no sign within ${queuedTurnStartLimitMs / 1000} seconds of Claude's Stop that Claude started a turn for the messages queued during that turn, so it is ending the turn.`,
    raw: "queued_turn_unconfirmed",
  };
}
