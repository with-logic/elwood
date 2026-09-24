/** Scope delayed Stop completion to its physical caller submission (PRD §5.3, C-HOOK-11/15). */
export class StopCompletion {
  private generation = 0;

  private readonly onSubmitted: () => void;

  constructor(onSubmitted: () => void) {
    this.onSubmitted = onSubmitted;
  }

  /** Called after a caller prompt's physical Enter, before the submission promise resolves. */
  readonly submitted = (): void => {
    this.generation += 1;
    this.onSubmitted();
  };

  /** Capture before Stop observers: callbacks may await another immediate prompt. */
  captureCurrentSubmission(): () => boolean {
    const generation = this.generation;
    return () => generation === this.generation;
  }
}
