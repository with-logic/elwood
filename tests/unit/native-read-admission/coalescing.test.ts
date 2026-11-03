/** Admission does not poison shared consumers or merge already-started scans (C-LIFE-10). */
import { afterEach, expect, test, vi } from "vitest";
import { coalesceUnstarted } from "../../../src/runtime/shutdown/coalesce.ts";
import { admitNativeProcessRead as admit } from "../../../src/runtime/shutdown/native-read-admission.ts";

afterEach(() => vi.useRealTimers());

test("C-LIFE-10 short consumer expiry preserves its longer shared read and later freshness", async () => {
  vi.useFakeTimers();
  const held = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const holders = held.map((control) => admit(1_000, () => control.promise));
  const firstSnapshot = Promise.withResolvers<number>();
  const budgets: number[] = [];
  const list = coalesceUnstarted((budget) =>
    admit(budget, (remaining) => {
      budgets.push(remaining);
      return budgets.length === 1 ? firstSnapshot.promise : Promise.resolve(84);
    }),
  );
  const short = list(10);
  const long = list(100);
  const observed = Promise.allSettled([short, long]);
  await vi.advanceTimersByTimeAsync(0); // The first batch starts but awaits native admission.
  const later = list(100);
  const all = Promise.allSettled([...holders, observed, later]);
  try {
    await vi.advanceTimersByTimeAsync(20);
    await expect(short).rejects.toMatchObject({ code: "ETIMEDOUT" });
    expect(budgets).toEqual([]);
    held[0]!.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(budgets).toEqual([80]);
    firstSnapshot.resolve(42);
    await expect(long).resolves.toBe(42);
    await expect(later).resolves.toBe(84);
    expect(budgets).toEqual([80, 80]);
  } finally {
    firstSnapshot.resolve(42);
    for (const control of held) control.resolve();
    await all;
  }
});
