/** Scope delayed Stop completion to its queue-backed caller submission (PRD §5.3, C-HOOK-11/15). */
import type { ElwoodSessionStatus } from "../../core/types.ts";

type SubmissionSession = {
  readonly status: ElwoodSessionStatus;
  submitEvidence(kind: "caller_submitted"): unknown;
};

export class StopCompletion {
  private generation = 0;
  private prepareReset: (() => () => void) | undefined;
  private pendingReset: (() => void) | undefined;
  private readonly session: SubmissionSession;

  constructor(session: SubmissionSession) {
    this.session = session;
  }

  /** Called after a queue-backed caller prompt's physical Enter, before the submission promise resolves. */
  readonly submitted = (): void => {
    this.generation += 1;
    const reset = this.pendingReset;
    this.pendingReset = undefined;
    reset?.();
    if (this.session.status === "ready") this.session.submitEvidence("caller_submitted");
  };

  /** Capture before Enter; failed writes never commit this reset or generation. */
  readonly prepareRenderedReset = (): void => {
    this.pendingReset = this.prepareReset?.();
  };

  /** Each adapter binds its watcher before startup can release queued input. */
  bindRenderedReset(prepare: () => () => void): void {
    this.prepareReset = prepare;
  }

  /** Capture before Stop observers: a callback can physically submit newer input. */
  captureSubmissionGeneration(): () => boolean {
    const generation = this.generation;
    return () => generation === this.generation;
  }
}
