/** Bounds pending notification diagnostics while consuming late rejections (C-HOOK-22). */
import { AsyncLocalStorage } from "node:async_hooks";

type Sink = (error: unknown) => void;
type Pending = {
  settled: boolean;
  readonly entries: Set<Registration>;
  overflowSink: WeakRef<Sink> | undefined;
};
type Registration = {
  readonly pending: Pending;
  readonly sink: Sink;
  readonly release: () => void;
  readonly overflowSink: WeakRef<Sink> | undefined;
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
    const overflowSink = pending.overflowSink?.deref();
    pending.overflowSink = undefined;
    if (rejected) {
      for (const sink of [
        ...(overflowSink ? [overflowSink] : []),
        ...entries.map((entry) => entry.sink),
      ]) {
        try {
          sink(error);
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

  /** The caller keeps reused session sinks live; overflow records retain only weak references. */
  observe(promise: Promise<unknown>, sink: Sink, retainOnOverflow: boolean): void {
    let pending = this.promises.get(promise);
    if (!pending || pending.settled) {
      pending = { settled: false, entries: new Set(), overflowSink: undefined };
      // Native attachment may throw while evaluating caller constructor/species.
      // Cache only after success so a later notification can retry.
      attach(promise, pending);
      this.promises.set(promise, pending);
    }
    const registrations = this.registrations;
    const entry: Registration = {
      pending,
      // A shared Promise reaction inherits only the first registration's context.
      sink: AsyncLocalStorage.bind(sink),
      overflowSink: retainOnOverflow ? new WeakRef(sink) : undefined,
      release: () => {
        registrations.delete(entry);
      },
    };
    pending.entries.add(entry);
    registrations.add(entry);
    if (registrations.size > MAX_PENDING) {
      // Size exceeds a positive cap, so the oldest entry necessarily exists.
      const oldest = registrations.values().next().value!;
      // The live session owns stable sinks; evicted promises must not retain that session.
      if (oldest.overflowSink && !oldest.pending.overflowSink)
        oldest.pending.overflowSink = oldest.overflowSink;
      oldest.pending.entries.delete(oldest);
      registrations.delete(oldest);
    }
  }
}
