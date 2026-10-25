/**
 * Gives Codex a bounded time to record the turn its `Stop` hook ended before a graceful
 * shutdown signals it. Implements PRD §5.7 (shutting down after a Codex turn) and C-LIFE-13.
 *
 * Codex runs the `Stop` hook before it records the turn's completion in its transcript,
 * and Elwood reports `ready` from that hook. Codex 0.164.0 signaled after the hook returns
 * but before that record is written exits without it, and the resumed conversation then
 * ends in "Conversation interrupted" (docs/cli-behavior.md, "Resume lifecycle"). The wait
 * also ends when the CLI exits or after `turnCommitWaitMs`; shutdown then proceeds, and a
 * turn Codex has still not recorded can be lost.
 */

import { outsideStopInput } from "../../core/stop-input.ts";
import { payloadOf } from "../transcript/payload.ts";
import { isTurnEndPayload } from "../transcript/turn-end.ts";

/** The longest `stop`/`teardown` wait for the record before signaling anyway. */
export const turnCommitWaitMs = 2_000;
/** Transcript re-read cadence while waiting; the watcher's own poll is 250 ms. */
const turnCommitPollMs = 20;

type PendingCommit = {
  readonly turnId: string;
  /** Settles once this turn's end is recorded or its `Stop` is blocked: the wait is over. */
  readonly waitFinished: Promise<void>;
  readonly release: () => void;
};

export class CodexTurnCommit {
  private pending: PendingCommit | undefined;
  private readonly poll: () => void;
  private readonly waitForCliExitOrTimeout: (timeoutMs: number) => Promise<unknown>;

  /**
   * `poll` reads newly committed transcript items into `observe` and contains its own
   * failures; `waitForCliExitOrTimeout` resolves when the CLI exits or `timeoutMs` passes.
   */
  constructor(poll: () => void, waitForCliExitOrTimeout: (timeoutMs: number) => Promise<unknown>) {
    this.poll = poll;
    this.waitForCliExitOrTimeout = waitForCliExitOrTimeout;
  }

  /**
   * A `Stop` hook for `turnId` arrived. Registered before any observer of that hook runs,
   * since an observer may shut the session down at once.
   */
  expect(turnId: string): void {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.pending = { turnId, waitFinished: promise, release: resolve };
  }

  /** Ends the wait for `turnId`: its end was recorded, or its `Stop` was blocked. */
  release(turnId: string): void {
    const pending = this.pending;
    if (pending?.turnId !== turnId) return;
    this.pending = undefined;
    pending.release();
  }

  /**
   * Reads one committed transcript item. Only a turn-end record carrying the pending
   * turn's id releases the wait: every captured end record carries one, and a record
   * without it could be an older turn's backlog.
   */
  observe(item: unknown): void {
    const payload = payloadOf(item);
    const turnId = payload?.["turn_id"];
    if (payload && isTurnEndPayload(payload) && typeof turnId === "string") this.release(turnId);
  }

  /**
   * Runs `shutdown` once the pending turn is recorded, its `Stop` is blocked, the CLI
   * exits, or `turnCommitWaitMs` passes, re-reading the transcript meanwhile. With no
   * turn pending, `shutdown` starts in the same tick. A turn not recorded within the
   * bound is not waited for again.
   */
  beforeShutdown(shutdown: () => Promise<void>): Promise<void> {
    const pending = this.pending;
    if (!pending) return shutdown();
    // Internal work outlives a Stop callback that called `stop()` (C-HOOK-22).
    const poll = outsideStopInput(() => setInterval(this.poll, turnCommitPollMs));
    const bound = this.waitForCliExitOrTimeout(turnCommitWaitMs);
    return Promise.race([pending.waitFinished, bound]).then(() => {
      clearInterval(poll);
      if (this.pending === pending) this.pending = undefined;
      return shutdown();
    });
  }
}
