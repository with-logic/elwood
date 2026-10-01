/** Coalesced, abortable render settlement without retained timed-out callers (PRD §5.3, C-API-56). */
type Observation = { done: boolean; readonly listeners: Set<() => void> };
const observations = new WeakMap<Promise<void>, Observation>();

/** Terminal settlement never rejects; render failure is reported separately by the terminal. */
export function observeRender(
  settled: Promise<void>,
  signal: AbortSignal | undefined,
  budgetMs?: number,
): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  let observation = observations.get(settled);
  if (!observation) {
    observation = { done: false, listeners: new Set() };
    observations.set(settled, observation);
    const shared = observation;
    void settled.then(() => {
      shared.done = true;
      for (const listener of shared.listeners) listener();
    });
  }
  if (observation.done) return Promise.resolve(true);
  const listeners = observation.listeners;
  return new Promise((resolve) => {
    let budget: ReturnType<typeof setTimeout> | undefined;
    const finish = (observed: boolean) => {
      clearTimeout(budget);
      listeners.delete(ready);
      signal?.removeEventListener("abort", giveUp);
      resolve(observed);
    };
    const ready = () => finish(true);
    const giveUp = () => finish(false);
    if (budgetMs !== undefined) {
      budget = setTimeout(giveUp, budgetMs);
      budget.unref?.();
    }
    listeners.add(ready);
    signal?.addEventListener("abort", giveUp, { once: true });
  });
}
