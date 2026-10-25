/**
 * Wakes a model-picker wait on each completed render instead of its next poll (PRD §5.3):
 * opening, reading, and closing the picker each waited up to one poll interval for a
 * frame that had already landed.
 */

/** Subscribes to completed renders; the returned call resolves on the next one. */
export function renderWakeup(
  observeRendered: ((listener: () => void) => void) | undefined,
): (() => Promise<void>) | undefined {
  if (observeRendered === undefined) return undefined;
  let next = Promise.withResolvers<void>();
  observeRendered(() => {
    next.resolve();
    next = Promise.withResolvers();
  });
  return () => next.promise;
}
