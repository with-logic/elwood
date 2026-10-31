/**
 * Per-session descendant signal passes (PRD §5.3, C-LIFE-10/C-LIFE-13/C-LIFE-14):
 * begin an idle pass in the caller's tick, and serialize every later pass behind it.
 */
export class SerialReapQueue {
  private tail: Promise<void> | undefined;

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
