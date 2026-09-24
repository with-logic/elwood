/** Reserve loop ordering without holding physical input through prior drain (PRD §5.8/§5.9). */
import { elwoodError, toError } from "../errors.ts";
import { type BoundarySession, observeTurnBoundary } from "./observe-boundary.ts";

const loopBoundaryTails = new WeakMap<object, Promise<void>>();

export function loopBoundaryTail(owner: object): Promise<void> | undefined {
  return loopBoundaryTails.get(owner);
}

export function reserveLoopSubmission(
  owner: object,
  session: BoundarySession,
  { closing, admission }: { readonly closing: AbortSignal; readonly admission: AbortSignal },
) {
  const predecessor = loopBoundaryTails.get(owner);
  const completion = Promise.withResolvers<void>();
  const tail = Promise.all([predecessor, completion.promise]).then(() => undefined);
  loopBoundaryTails.set(owner, tail);
  const forget = () => {
    if (loopBoundaryTails.get(owner) === tail) loopBoundaryTails.delete(owner);
  };
  void tail.then(forget, forget);
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
    /** Wait for admission, then resolve after physical submission, not transcript drain. */
    async submit(write: () => Promise<void>): Promise<void> {
      await ready;
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
        await write();
      } catch (error) {
        observer.discard();
        throw error;
      } finally {
        submissionSettled.resolve();
      }
    },
  };
}
