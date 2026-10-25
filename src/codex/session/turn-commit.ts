/**
 * Holds a graceful Codex shutdown until the turn its last `Stop` hook ended is committed.
 * Implements PRD §5.7 (shutting down after a Codex turn) and C-LIFE-13.
 *
 * Codex runs the `Stop` hook before it records the turn's completion in its transcript,
 * and Elwood reports `ready` from that hook. Codex 0.164.0 signaled in that gap exits
 * without the record, and the resumed conversation then ends in "Conversation
 * interrupted" (docs/cli-behavior.md, "Resume lifecycle").
 */

import { isRecord } from "../../core/predicates.ts";

/** The longest `stop`/`teardown` wait for the commit before signaling anyway. */
export const turnCommitWaitMs = 2_000;
/** Transcript re-read cadence while waiting; the watcher's own poll is 250 ms. */
const turnCommitScanMs = 20;
const turnEndTypes = new Set(["task_complete", "turn_complete", "turn_aborted", "turn_failed"]);

type PendingCommit = {
  readonly turnId: string;
  readonly committed: Promise<void>;
  readonly release: () => void;
};

export class CodexTurnCommit {
  private pending: PendingCommit | undefined;
  private readonly scan: () => void;
  private readonly exited: (timeoutMs: number) => Promise<unknown>;

  /**
   * `scan` reads newly committed transcript items into `observe`; `exited` resolves when
   * the CLI exits or `timeoutMs` passes.
   */
  constructor(scan: () => void, exited: (timeoutMs: number) => Promise<unknown>) {
    this.scan = scan;
    this.exited = exited;
  }

  /** An unblocked `Stop` hook ended `turnId`, which Codex has not recorded as complete yet. */
  expect(turnId: string): void {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.pending = { turnId, committed: promise, release: resolve };
  }

  /** Reads one committed transcript item; the pending turn's end releases the wait. */
  observe(item: unknown): void {
    const pending = this.pending;
    const payload = isRecord(item) && isRecord(item["payload"]) ? item["payload"] : undefined;
    const type = payload?.["type"];
    if (!pending || typeof type !== "string" || !turnEndTypes.has(type)) return;
    // A record without a turn id cannot belong to another turn: the hook-time scan
    // already read every record committed before this turn's `Stop`.
    const turnId = payload?.["turn_id"];
    if (typeof turnId === "string" && turnId !== pending.turnId) return;
    this.pending = undefined;
    pending.release();
  }

  /**
   * Runs `shutdown` once the pending turn is committed, the CLI exits, or
   * `turnCommitWaitMs` passes, re-reading the transcript meanwhile. With no turn
   * pending, `shutdown` starts in the same tick. A commit that never came is not
   * waited for again.
   */
  before(shutdown: () => Promise<void>): Promise<void> {
    const pending = this.pending;
    if (!pending) return shutdown();
    const poll = setInterval(this.scan, turnCommitScanMs);
    return Promise.race([pending.committed, this.exited(turnCommitWaitMs)]).then(() => {
      clearInterval(poll);
      if (this.pending === pending) this.pending = undefined;
      return shutdown();
    });
  }
}
