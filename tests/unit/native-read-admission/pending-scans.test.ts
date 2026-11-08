/** Pending snapshots share native capacity without weakening freshness or deadlines (C-LIFE-10). */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { coalesceBeforeNativeAdmission } from "../../../src/runtime/shutdown/coalesce-before-native-admission.ts";
import {
  admitNativeProcessRead as admit,
  reserveNativeProcessRead,
} from "../../../src/runtime/shutdown/native-read-admission.ts";
import type { PsRunner } from "../../../src/runtime/shutdown/process-table.ts";
import { createUnreferencedProcessTableReader } from "../../../src/runtime/shutdown/unreferenced-read.ts";

const cleanup: (() => Promise<void>)[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  for (const release of cleanup.splice(0)) await release();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function heldSlots() {
  const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()] as const;
  const running = gates.map((gate) => admit(1_000, () => gate.promise));
  const release = async () => {
    for (const gate of gates) gate.resolve();
    await Promise.all(running);
  };
  cleanup.push(release);
  return { gates, release };
}

test("C-LIFE-10 a late queued consumer shares one snapshot; in-flight requests stay FIFO and fresh", async () => {
  const held = heldSlots();
  const snapshot = Promise.withResolvers<{ stdout: string }>();
  cleanup.push(() => {
    snapshot.resolve({ stdout: "" });
    return Promise.resolve();
  });
  const order: string[] = [];
  let snapshots = 0;
  const native = vi.fn<PsRunner>(() => {
    order.push("scan");
    snapshots += 1;
    return snapshots === 1 ? snapshot.promise : Promise.resolve({ stdout: "" });
  });
  const read = createUnreferencedProcessTableReader(native);
  const first = read(100);
  await vi.advanceTimersByTimeAsync(1);
  const probe = admit(200, () => {
    order.push("probe");
    return Promise.resolve();
  });
  const joined = read(200);
  await vi.advanceTimersByTimeAsync(10);
  held.gates[0].resolve();
  await vi.advanceTimersByTimeAsync(1);
  expect(native).toHaveBeenCalledOnce();
  const later = read(200);
  await vi.advanceTimersByTimeAsync(1);
  snapshot.resolve({ stdout: "" });
  const [a, b] = await Promise.all([first, joined]);
  expect(a).toBe(b);
  await Promise.all([probe, later]);
  expect(order).toEqual(["scan", "probe", "scan"]);
  await held.release();
});

test("C-LIFE-10 a later longer consumer extends the queued deadline without reviving a short one", async () => {
  const held = heldSlots();
  const native = vi.fn<PsRunner>(() => Promise.resolve({ stdout: "" }));
  const read = createUnreferencedProcessTableReader(native);
  const short = read(10);
  const observed = Promise.allSettled([short]);
  await vi.advanceTimersByTimeAsync(5);
  const long = read(100);
  const longObserved = Promise.allSettled([long]);
  await vi.advanceTimersByTimeAsync(10);
  await expect(short).rejects.toMatchObject({ code: "ETIMEDOUT" });
  held.gates[0].resolve();
  await expect(long).resolves.toEqual([]);
  expect(native.mock.calls[0]?.[2].timeout).toBe(90);
  expect(native).toHaveBeenCalledOnce();
  await observed;
  await longObserved;
  await held.release();
});

test("C-LIFE-10 all expired consumers cancel queued native work", async () => {
  const held = heldSlots();
  const native = vi.fn<PsRunner>(() => Promise.resolve({ stdout: "" }));
  const read = createUnreferencedProcessTableReader(native);
  const pending = read(10);
  const observed = Promise.allSettled([pending]);
  await vi.advanceTimersByTimeAsync(20);
  await expect(pending).rejects.toMatchObject({ code: "ETIMEDOUT" });
  await held.release();
  await observed;
  expect(native).not.toHaveBeenCalled();
});

test.each([
  true,
  false,
])("C-LIFE-10 ref=%s preserves coalescing/consumer liveness and zero-budget no-spawn", async (ref) => {
  const immediate = vi.spyOn(globalThis, "setImmediate");
  const timer = vi.spyOn(globalThis, "setTimeout");
  const run = vi.fn(() => Promise.resolve(42));
  const read = coalesceBeforeNativeAdmission(run, { ref });
  const pending = read(0);
  const observed = Promise.allSettled([pending]);
  expect(immediate.mock.results[0]?.value.hasRef()).toBe(ref);
  expect(timer.mock.results[0]?.value.hasRef()).toBe(ref);
  await vi.advanceTimersByTimeAsync(1);
  await expect(pending).rejects.toMatchObject({ code: "ETIMEDOUT" });
  expect(run).not.toHaveBeenCalled();
  await observed;
});

test("C-LIFE-10 delayed timers cannot revive expired queue positions or accept late results", async () => {
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const held = heldSlots();
  const snapshot = Promise.withResolvers<number>();
  const read = coalesceBeforeNativeAdmission(() => snapshot.promise);
  const expired = read(10);
  const observed = Promise.allSettled([expired]);
  await vi.advanceTimersByTimeAsync(1);
  clock = 20;
  const fresh = read(100);
  const longer = read(200);
  await vi.advanceTimersByTimeAsync(1);
  held.gates[0].resolve();
  await Promise.resolve();
  clock = 150;
  snapshot.resolve(42);
  await expect(expired).rejects.toMatchObject({ code: "ETIMEDOUT" });
  await expect(fresh).rejects.toMatchObject({ code: "ETIMEDOUT" });
  await expect(longer).resolves.toBe(42);
  await observed;
  await held.release();
});

test("C-LIFE-10 failed native batches reject their consumers and release capacity", async () => {
  const error = new Error("native failure");
  const read = coalesceBeforeNativeAdmission(() => Promise.reject(error));
  const pending = read(100);
  const observed = Promise.allSettled([pending]);
  await vi.advanceTimersByTimeAsync(1);
  await expect(pending).rejects.toBe(error);
  await observed;
  const result = Promise.withResolvers<number>();
  const reservation = reserveNativeProcessRead(performance.now() + 100, () => result.promise);
  reservation.extendUntil(performance.now() + 200);
  reservation.cancel();
  result.resolve(42);
  await expect(reservation.result).resolves.toBe(42);
});
