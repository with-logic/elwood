/**
 * Per-session descendant signal passes (PRD §5.3 and §9.4, C-LIFE-10):
 * begin an idle pass in the caller's tick, and serialize every later pass behind it.
 */
export class SerialDetachedSweepQueue {
  private tail: Promise<void> | undefined;

  /** Return this attempt’s outcome; release the next pass after either success or failure. */
  run<T>(attempt: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    const { promise: held, resolve } = Promise.withResolvers<void>();
    this.tail = held;
    const release = () => {
      resolve();
      if (this.tail === held) this.tail = undefined;
    };
    let result: Promise<T>;
    try {
      result = previous === undefined ? attempt() : previous.then(attempt);
    } catch (error) {
      release();
      return Promise.reject(error);
    }
    void result.then(release, release);
    return result;
  }
}
