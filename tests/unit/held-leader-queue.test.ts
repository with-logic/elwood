/** Leader verification and recovery share one session's signal ownership (C-LIFE-10/C-LIFE-14). */
import { afterEach, expect, test, vi } from "vitest";
import type { ProcessEntry } from "../../src/runtime/shutdown/process-table.ts";
import { SessionReaper } from "../../src/runtime/shutdown/reap-tree.ts";
import { errno, hook, LEADER, leaderRow, scripted } from "../helpers/scripted-process-tree.ts";

afterEach(() => vi.useRealTimers());

test("C-LIFE-14 a held-leader signal waits for the session's earlier background pass", async () => {
  vi.useFakeTimers();
  const held = Promise.withResolvers<readonly ProcessEntry[]>();
  const fake = scripted([[leaderRow, hook(10_000_001)]]);
  let reads = 0;
  const reaper = new SessionReaper(LEADER, {
    ...fake.ops,
    listProcesses: (ms: number) =>
      ++reads === 2 ? Promise.reject(errno("EIO")) : fake.ops.listProcesses(ms),
    listProcessesUnreferenced: () => held.promise,
  });
  await expect(reaper.sweepDetached(() => false)).rejects.toThrow("process table unreadable");
  await vi.advanceTimersByTimeAsync(0);
  const watch = reaper.watchSurvivors(() => false);
  await watch.firstRead;
  const before = fake.calls.filter((call) => call !== "list");
  const signal = vi.fn();
  const pending = watch.sendSignal(signal);
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(signal).not.toHaveBeenCalled();
    expect(fake.calls.filter((call) => call !== "list")).toEqual(before);
    held.resolve([]);
    await pending;
    expect(signal).toHaveBeenCalledOnce();
  } finally {
    held.resolve([]);
    await pending.catch(() => undefined);
    await watch.finish();
  }
});

test("C-LIFE-10 waiting for a signal queue never adopts a later leader after a failed first read", async () => {
  vi.useFakeTimers();
  const held = Promise.withResolvers<readonly ProcessEntry[]>();
  const fake = scripted([[leaderRow, hook(10_000_001)]]);
  let reads = 0;
  const replacement = { ...leaderRow, startedAt: "Sun Oct 25 22:00:09 2026" };
  const reaper = new SessionReaper(LEADER, {
    ...fake.ops,
    listProcesses: (ms: number) => {
      reads += 1;
      if (reads === 2 || reads === 3) return Promise.reject(errno("EIO"));
      return reads > 3 ? Promise.resolve(fake.asRead([replacement])) : fake.ops.listProcesses(ms);
    },
    listProcessesUnreferenced: () => held.promise,
  });
  await expect(reaper.sweepDetached(() => false)).rejects.toThrow("process table unreadable");
  await vi.advanceTimersByTimeAsync(0);
  const watch = reaper.watchSurvivors(() => false);
  expect(await watch.firstRead).toBe(false);
  await vi.advanceTimersByTimeAsync(0);
  const signal = vi.fn();
  const pending = watch.sendSignal(signal);
  const refused = expect(pending).rejects.toThrow("No recorded leader identity");
  try {
    expect(reads).toBeGreaterThanOrEqual(4);
    held.resolve([]);
    await refused;
    expect(signal).not.toHaveBeenCalled();
  } finally {
    held.resolve([]);
    await pending.catch(() => undefined);
    await watch.finish();
  }
});
