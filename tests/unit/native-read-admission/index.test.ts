/** Shared native-read admission preserves FIFO, deadlines and capacity (C-LIFE-10). */
import { afterEach, expect, test, vi } from "vitest";
import {
  admitNativeProcessRead as admit,
  createAdmittedPsRunner,
} from "../../../src/runtime/shutdown/native-read-admission.ts";

import { type PsRunner, psRunOptions } from "../../../src/runtime/shutdown/process-table.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("C-LIFE-10 one FIFO bound holds across staggered reader launches", async () => {
  const controls = Array.from({ length: 8 }, () => Promise.withResolvers<number>());
  const launches: number[] = [];
  const pending = controls.map((control, index) =>
    admit(1_000, () => {
      launches.push(index);
      return control.promise;
    }),
  );
  const settled = Promise.allSettled(pending);
  try {
    expect(launches).toEqual([0, 1]);
    controls[0]!.resolve(0);
    await pending[0];
    expect(launches).toEqual([0, 1, 2]);
    controls[1]!.resolve(1);
    await pending[1];
    expect(launches).toEqual([0, 1, 2, 3]);
  } finally {
    for (const [index, control] of controls.entries()) control.resolve(index);
    await settled;
  }
  expect(launches).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
});

test("C-LIFE-10 synchronous and rejected runners both release their slot", async () => {
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  const holders = [admit(1_000, () => first.promise), admit(1_000, () => second.promise)];
  const failure = new Error("read failed");
  const throwing = admit(1_000, () => {
    throw failure;
  });
  const rejected = admit(1_000, () => Promise.reject(failure));
  const healthy = admit(1_000, () => Promise.resolve("fresh table"));
  const settled = Promise.allSettled([...holders, throwing, rejected, healthy]);
  first.resolve();
  try {
    await expect(throwing).rejects.toBe(failure);
    await expect(rejected).rejects.toBe(failure);
    await expect(healthy).resolves.toBe("fresh table");
  } finally {
    second.resolve();
    await settled;
  }
});

test("C-LIFE-10 queued expiry launches nothing and leaves the next reader's remaining budget", async () => {
  vi.useFakeTimers();
  const held = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const holders = held.map((control) => admit(1_000, () => control.promise));
  const expiredLaunch = vi.fn(() => Promise.resolve());
  const expired = admit(10, expiredLaunch);
  const nextLaunch = vi.fn((remainingMs: number) => Promise.resolve(remainingMs));
  const next = admit(100, nextLaunch);
  const settled = Promise.allSettled([...holders, expired, next]);
  try {
    await vi.advanceTimersByTimeAsync(20);
    await expect(expired).rejects.toMatchObject({ code: "ETIMEDOUT" });
    expect(expiredLaunch).not.toHaveBeenCalled();
    held[0]!.resolve();
    await expect(next).resolves.toBe(80);
    expect(nextLaunch).toHaveBeenCalledOnce();
  } finally {
    for (const control of held) control.resolve();
    await settled;
  }
});

test("C-LIFE-10 a delayed timer cannot authorize a launch after its absolute deadline", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const held = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const holders = held.map((control) => admit(1_000, () => control.promise));
  const launch = vi.fn(() => Promise.resolve());
  const expired = admit(10, launch);
  const settled = Promise.allSettled([...holders, expired]);
  now = 20; // Advance the admission clock without dispatching timeout callbacks.
  held[0]!.resolve();
  try {
    await expect(expired).rejects.toMatchObject({ code: "ETIMEDOUT" });
    expect(launch).not.toHaveBeenCalled();
  } finally {
    for (const control of held) control.resolve();
    await settled;
  }
});

test("C-LIFE-10 native runner adapters share the gate and forward only their remaining timeout", async () => {
  vi.useFakeTimers();
  const held = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const holders = held.map((control) => admit(1_000, () => control.promise));
  const native = vi.fn<PsRunner>(() => Promise.resolve({ stdout: "fresh" }));
  const scan = createAdmittedPsRunner(native);
  const probe = createAdmittedPsRunner(native);
  const options = psRunOptions(100);
  const queued = [scan("/bin/ps", ["-A"], options), probe("/bin/ps", ["-p", "5000"], options)];
  const settled = Promise.allSettled([...holders, ...queued]);
  try {
    await vi.advanceTimersByTimeAsync(20);
    expect(native).not.toHaveBeenCalled();
    held[0]!.resolve();
    await Promise.all(queued);
    expect(native.mock.calls).toEqual([
      ["/bin/ps", ["-A"], { ...options, timeout: 80 }],
      ["/bin/ps", ["-p", "5000"], { ...options, timeout: 80 }],
    ]);
  } finally {
    for (const control of held) control.resolve();
    await settled;
  }
});
