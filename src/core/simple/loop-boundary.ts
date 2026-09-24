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
  const observer = observeTurnBoundary(session, closing);
  const submitted = Promise.withResolvers<void>();
  const boundary = Promise.all([submitted.promise, observer.promise]).then(() => undefined);
  activeLoops.set(owner, boundary);
  const forget = () => {
    if (activeLoops.get(owner) === boundary) activeLoops.delete(owner);
  };
  // A loop can finish or close without an ergonomic caller waiting for it.
  void boundary.then(forget, forget);
  try {
    await submit();
  } catch (error) {
    observer.discard();
    throw error;
  } finally {
    submitted.resolve();
  }
}
