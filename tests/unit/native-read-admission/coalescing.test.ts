/** Production batching preserves largest budgets and independent in-flight deadlines (C-LIFE-10). */
import { afterEach, expect, test, vi } from "vitest";
import { coalesceBeforeNativeAdmission } from "../../../src/runtime/shutdown/coalesce-before-native-admission.ts";

afterEach(() => vi.useRealTimers());

test("C-LIFE-10 calls before native launch share the largest remaining timeout", async () => {
  vi.useFakeTimers();
  const budgets: number[] = [];
  const read = coalesceBeforeNativeAdmission((budget) => {
    budgets.push(budget);
    return Promise.resolve(42);
  });
  const joined = [read(1_200), read(3_000), read(2_000)];
  expect(budgets).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(await Promise.all(joined)).toEqual([42, 42, 42]);
  expect(budgets).toEqual([3_000]);
});

test("C-LIFE-10 an in-flight short deadline cannot cancel a longer consumer", async () => {
  vi.useFakeTimers();
  const snapshot = Promise.withResolvers<string>();
  const read = coalesceBeforeNativeAdmission(() => snapshot.promise);
  const short = read(10);
  const long = read(3_000);
  const timedOut = expect(short).rejects.toMatchObject({ code: "ETIMEDOUT" });
  try {
    await vi.advanceTimersByTimeAsync(15);
    await timedOut;
    snapshot.resolve("table");
    await expect(long).resolves.toBe("table");
  } finally {
    snapshot.resolve("table");
    await Promise.allSettled([short, long]);
  }
});
