/** Finish independent question notifications before surfacing observer failures (PRD §4). */
export class QuestionObserverFailure extends Error {
  readonly originalError: unknown;
  constructor(originalError: unknown) {
    super("A question lifecycle observer failed.");
    this.name = "QuestionObserverFailure";
    this.originalError = originalError;
  }
}

/** Synchronous, nested scopes retain only the first known notification failure. */
export class QuestionNotificationErrors {
  private depth = 0;
  private failure: QuestionObserverFailure | undefined;

  run<T>(operation: () => T): T {
    this.depth += 1;
    let failure: QuestionObserverFailure | undefined;
    let result: T;
    try {
      result = operation();
    } finally {
      this.depth -= 1;
      if (this.depth === 0) {
        failure = this.failure;
        this.failure = undefined;
      }
    }
    // A primary operation exception bypasses this point after resetting the batch.
    if (failure) throw failure;
    return result;
  }

  /** Capture only known registry notification operations, never arbitrary work. */
  capture(operation: () => void): void {
    this.run(() => {
      try {
        operation();
      } catch (error) {
        this.failure ??= new QuestionObserverFailure(error);
      }
    });
  }
}
