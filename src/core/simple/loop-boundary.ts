/** Retain dispatched loop boundaries before ergonomic collection (PRD §5.8/§5.9). */
import { type BoundarySession, observeTurnBoundary } from "./observe-boundary.ts";

const activeLoops = new WeakMap<object, Promise<void>>();

export function activeLoopBoundary(session: object): Promise<void> | undefined {
  return activeLoops.get(session);
}

export async function observeLoopSubmission(
  owner: object,
  session: BoundarySession,
  closing: AbortSignal,
  submit: () => Promise<void>,
): Promise<void> {
  const predecessor = activeLoops.get(owner);
  const completion = Promise.withResolvers<void>();
  const boundary = completion.promise;
  activeLoops.set(owner, boundary);
  const forget = () => {
    if (activeLoops.get(owner) === boundary) activeLoops.delete(owner);
  };
  // A loop can finish or close without an ergonomic caller waiting for it.
  void boundary.then(forget, forget);
  // Passive observers have no turn identity for untagged activity. Install the
  // next observer only after its predecessor has drained, before its own write.
  try {
    if (predecessor) await predecessor;
  } catch (error) {
    completion.reject(error);
    throw error;
  }
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
}
