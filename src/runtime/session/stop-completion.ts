/** Scope delayed Stop completion to its queue-backed caller submission (PRD §5.3, C-HOOK-11/15). */
import type { ElwoodSessionStatus } from "../../core/types.ts";

type SubmissionSession = {
  readonly status: ElwoodSessionStatus;
  submitEvidence(kind: "caller_submitted"): unknown;
};

export class StopCompletion {
  private generation = 0;
  private readonly session: SubmissionSession;

  constructor(session: SubmissionSession) {
    this.session = session;
  }

  /** Called after a queue-backed caller prompt's physical Enter, before the submission promise resolves. */
  readonly submitted = (): void => {
    this.generation += 1;
    if (this.session.status === "ready") this.session.submitEvidence("caller_submitted");
  };

  /** Capture before Stop observers: a callback can physically submit a newer turn. */
  captureSubmissionGeneration(): () => boolean {
    const generation = this.generation;
    return () => generation === this.generation;
  }
}
