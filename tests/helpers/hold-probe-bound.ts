/** Gate one explicit probe deadline on fixture readiness while keeping native timers. */
import { vi } from "vitest";

export function holdProbeBoundUntilReady(ms: number): () => void {
  const ready = Promise.withResolvers<void>();
  const setTimeout = globalThis.setTimeout;
  let held = false;
  vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
    if (delay !== ms || held) return setTimeout(callback, delay, ...args);
    held = true;
    return setTimeout(() => void ready.promise.then(() => callback(...args)), delay);
  });
  return () => ready.resolve();
}
