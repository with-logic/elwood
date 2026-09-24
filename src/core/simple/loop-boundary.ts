/** Reserve loop ordering without holding physical input through prior drain (PRD §5.8/§5.9). */
import { elwoodError, toError } from "../errors.ts";
import { type BoundarySession, observeTurnBoundary } from "./observe-boundary.ts";

const activeLoops = new WeakMap<object, Promise<void>>();

export function activeLoopBoundary(session: object): Promise<void> | undefined {
  return activeLoops.get(session);
}

export function reserveLoopSubmission(
  owner: object,
  session: BoundarySession,
  closing: AbortSignal,
  admission: AbortSignal,
) {
  const predecessor = activeLoops.get(owner);
  const completion = Promise.withResolvers<void>();
  const boundary = Promise.all([predecessor, completion.promise]).then(() => undefined);
  activeLoops.set(owner, boundary);
  const forget = () => {
    if (activeLoops.get(owner) === boundary) activeLoops.delete(owner);
  };
  void boundary.then(forget, forget);
  const signal = AbortSignal.any([closing, admission]);
  const abortError = () =>
    closing.aborted
      ? elwoodError("session_not_running", "Session is closing.")
      : toError(signal.reason);
  let removeAbort: () => void;
  const ready = new Promise<void>((resolve, reject) => {
    const abort = () => {
      completion.resolve();
      removeAbort();
      reject(abortError());
    };
    removeAbort = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void Promise.resolve(predecessor).then(
      () => {
        resolve();
      },
      (error: unknown) => {
        removeAbort();
        completion.resolve();
        reject(error);
      },
    );
  });
  return {
    ready,
    async run(submit: () => Promise<void>): Promise<void> {
      removeAbort();
      if (signal.aborted) {
        completion.resolve();
        throw abortError();
      }
      // Only one untagged collector exists; admission waited outside the input slot.
      const observer = observeTurnBoundary(session, closing);
      const submissionSettled = Promise.withResolvers<void>();
      void Promise.all([submissionSettled.promise, observer.promise]).then(
        () => completion.resolve(),
        completion.reject,
      );
      try {
        await submit();
      } catch (error) {
        observer.discard();
        throw error;
      } finally {
        submissionSettled.resolve();
      }
    },
  };
}
