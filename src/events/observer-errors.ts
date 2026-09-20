/** Bounds pending notification diagnostics while consuming late rejections (C-HOOK-22). */
type Sink = (error: unknown) => void;
type Pending = { settled: boolean; readonly entries: Set<Registration> };
type Registration = {
  readonly pending: Pending;
  readonly sink: Sink;
  readonly release: () => void;
};
const MAX_PENDING = 1_024;
const promiseThen = Promise.prototype.then;

// These callbacks capture only the Promise's record. Eviction empties its entry
// set, so a retained never-settling Promise cannot retain an invocation or emitter.
function attach(promise: Promise<unknown>, pending: Pending): void {
  const settle = (rejected: boolean, error?: unknown): void => {
    pending.settled = true;
    const entries = [...pending.entries];
    pending.entries.clear();
    for (const entry of entries) entry.release();
    if (rejected) {
      for (const entry of entries) {
        try {
          entry.sink(error);
        } catch {
          /* A diagnostic cannot create another rejection. */
        }
      }
    }
  };
  void promiseThen.call(
    promise,
    () => settle(false),
    (error: unknown) => settle(true, error),
  );
}

export class ObserverErrors {
  private readonly promises = new WeakMap<Promise<unknown>, Pending>();
  private readonly registrations = new Set<Registration>();

  observe(promise: Promise<unknown>, sink: Sink): void {
    let pending = this.promises.get(promise);
    if (!pending || pending.settled) {
      pending = { settled: false, entries: new Set() };
      // Native attachment may throw while evaluating caller constructor/species.
      // Cache only after success so a later notification can retry.
      attach(promise, pending);
      this.promises.set(promise, pending);
    }
    const registrations = this.registrations;
    const entry: Registration = {
      pending,
      sink,
      release: () => {
        registrations.delete(entry);
      },
    };
    pending.entries.add(entry);
    registrations.add(entry);
    if (registrations.size > MAX_PENDING) {
      // Size exceeds a positive cap, so the oldest entry necessarily exists.
      const oldest = registrations.values().next().value!;
      oldest.pending.entries.delete(oldest);
      registrations.delete(oldest);
    }
  }
}
