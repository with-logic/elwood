/**
 * Claude Code 2.1.332 runs every message still queued at a turn's `Stop` as one new turn right
 * away, so that `Stop` must not mark the session ready (PRD §6.5, C-HOOK-24). Claude writes a
 * `queue-operation` `dequeue` record per message 74 to 340 ms after the `Stop` (measured), then a
 * `queued` user record per message. Once both are read, the queued turn's prompt ID is known and
 * its own `Stop` marks readiness. Claude runs a message only once the caller's `UserPromptSubmit`
 * handler allows it, so the confirmation window restarts when screening ends, and a `Stop` whose
 * messages were all blocked ends the turn then. Messages that still lack a `queued` record when the
 * window closes, after a `dequeue`, are forgotten and leave readiness to that turn's `Stop`. Without
 * a `dequeue` by then, Claude did not run them: they are forgotten, and this `Stop` warns and marks
 * readiness unless something else ended its turn or started another. Only a read that reached the
 * end of the `Stop`'s transcript can show that no `dequeue` was written, so while reads fail or fall
 * behind, the window stays open up to a fallback.
 */
import type { HookObservation } from "../../core/hook-observation.ts";
import { outsideStopInput } from "../../core/stop-input.ts";
import { deadlineClock } from "../../core/timers.ts";
import type { ClaudeTranscriptWatcher } from "../transcript/index.ts";

/**
 * How long a held `Stop` waits for Claude to start the queued turn, from the `Stop` and again from
 * the end of each screening. It closes only at a read that reached the end of the `Stop`'s
 * transcript, or `unreadTranscriptLimitMs` later, so it does not cap the hold (C-HOOK-24).
 */
const confirmWindowMs = 2_000;
/** How long past the window a failed read, a backlog, or a partly written record keeps it open. */
const unreadTranscriptLimitMs = 10_000;
/** Below the earliest measured `dequeue`, so the queued turn's records are read promptly. */
const pollIntervalMs = 50;
/** One 256 KiB chunk per poll, so a transcript backlog drains without long event-loop blocks. */
const pollScanChunks = 1;
/**
 * Claude stamps a `dequeue` after it receives the `Stop`'s response. The allowance absorbs a stamp
 * truncated to the second or a clock step, and is far shorter than an earlier queued turn.
 */
const dequeueStampAllowanceMs = 1_000;

/** Where a held `Stop` looks for the queued turn's records. */
export type QueuedTurnEvidence = {
  readonly transcriptWatcher: Pick<ClaudeTranscriptWatcher, "scanPath" | "queuedPrompts">;
  /** The `Stop`'s own transcript, the only one Claude writes the queued turn's records to. */
  readonly transcriptPath: string | undefined;
};

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
  const queued = evidence.transcriptWatcher.queuedPrompts();
  if (queued === undefined) return false;
  const window = queued.takeStopWindow();
  if (!queued.hasRunnableIn(window)) {
    // Blocked messages never run, and earlier messages belong to an earlier `Stop`.
    queued.forgetBefore(window.to);
    return false;
  }
  const dequeueCutoffAtMs = Date.now() - dequeueStampAllowanceMs;
  let windowEndsAtMs = deadlineClock.now() + confirmWindowMs;
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
    let readToEnd = false;
    end.observation.run("transcript", () => {
      readToEnd = evidence.transcriptWatcher.scanPath(evidence.transcriptPath, pollScanChunks);
    });
    const started = queued.dequeuedSince(dequeueCutoffAtMs);
    const runnable = queued.hasRunnableIn(window);
    // Claude started the queued turn, and its `queued` records named its prompt ID.
    if (started && !runnable) {
      end.release();
      return;
    }
    const nowMs = deadlineClock.now();
    if (end.screening()) windowEndsAtMs = nowMs + confirmWindowMs;
    // Claude runs none of the messages: every one was blocked.
    else if (!(started || runnable)) {
      finish(false);
      return;
    }
    // Records the last read did not reach may show the queued turn starting.
    const unread = !readToEnd && nowMs < windowEndsAtMs + unreadTranscriptLimitMs;
    if (nowMs < windowEndsAtMs || unread) {
      schedule();
      return;
    }
    // A queued turn that started ends at its own `Stop`.
    finish(started ? undefined : true);
  };
  schedule();
  return true;
}
