/** Background retry ownership and shared-daemon resumption (PRD §5.3, C-LIFE-14). */
import { afterEach, expect, test, vi } from "vitest";
import {
  BACKGROUND_REAP_RETRY_MS,
  reapInBackground,
} from "../../src/runtime/shutdown/detached-sweep/background.ts";
import { DescendantRecord } from "../../src/runtime/shutdown/detached-sweep/record.ts";
import { SessionReaper } from "../../src/runtime/shutdown/reap-tree.ts";
import {
  errno,
  hook,
  LEADER,
  leaderNeverExits,
  leaderRow,
  scripted,
} from "../helpers/scripted-process-tree.ts";

afterEach(() => vi.useRealTimers());

test("C-LIFE-14 a failed daemon resume stays unresolved until its SIGCONT succeeds", async () => {
  vi.useFakeTimers();
  let shared = false;
  let resumeWorks = false;
  const daemon = hook(5002, { shared: true, stopped: true, ppid: 1 });
  const fake = scripted([]);
  const ops = {
    ...fake.ops,
    listProcesses: () =>
      Promise.resolve(fake.asRead(shared ? [leaderRow, daemon] : [leaderRow, hook(5002)])),
    continueGroup: vi.fn(() => {
      if (!resumeWorks) throw errno("EPERM");
    }),
    stopGroup: (id: number) => {
      fake.ops.stopGroup(id);
      if (id === 5002) shared = true;
    },
  };
  const reaper = new SessionReaper(LEADER, ops);
  await expect(reaper.sweepDetached(leaderNeverExits)).rejects.toThrow("could not resume");
  await vi.advanceTimersByTimeAsync(0);
  expect(() => reaper.reapAndThrowOnDetachedSweepFailure()).toThrow("could not resume");
  resumeWorks = true;
  await vi.advanceTimersByTimeAsync(BACKGROUND_REAP_RETRY_MS);
  expect(ops.continueGroup).toHaveBeenCalledWith(5002);
  expect(() => reaper.reapAndThrowOnDetachedSweepFailure()).not.toThrow();
});

test("C-LIFE-14 foreground survivor cleanup waits for the same session's background attempt", async () => {
  vi.useFakeTimers();
  const held = Promise.withResolvers<readonly []>();
  let backgroundStarted = false;
  let backgroundReads = 0;
  const fake = scripted([[leaderRow, hook(5002)]]);
  let foregroundReads = 0;
  const reaper = new SessionReaper(LEADER, {
    ...fake.ops,
    listProcesses: () => {
      foregroundReads += 1;
      if (foregroundReads === 2) return Promise.reject(errno("ETIMEDOUT"));
      return Promise.resolve(fake.asRead([leaderRow, hook(5002)]));
    },
    listProcessesUnreferenced: () => {
      backgroundStarted = true;
      backgroundReads += 1;
      return held.promise;
    },
  });
  await expect(reaper.sweepDetached(leaderNeverExits)).rejects.toThrow("process table unreadable");
  await vi.advanceTimersByTimeAsync(0);
  expect(backgroundStarted).toBe(true);
  let exited = false;
  const watch = reaper.watchSurvivors(() => exited);
  await watch.firstRead;
  exited = true;
  const before = foregroundReads;
  const finished = watch.finish();
  await vi.advanceTimersByTimeAsync(0);
  expect(foregroundReads).toBe(before);
  held.resolve([]);
  await finished;
  expect(backgroundReads).toBe(1);
});

test.each([
  0, 1_500,
])("C-LIFE-14 background retries never signal an identity whose start second overlaps its first read (%s ms)", async (readDelay) => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-25T22:00:00.500Z"));
  const fake = scripted([]);
  let reads = 0;
  const reaper = new SessionReaper(LEADER, {
    ...fake.ops,
    listProcesses: () => {
      reads += 1;
      if (reads === 1) vi.setSystemTime(new Date("2026-10-25T22:00:00.500Z").getTime() + readDelay);
      if (reads === 2) return Promise.reject(errno("ETIMEDOUT"));
      return Promise.resolve(
        fake.asRead(reads === 1 ? [leaderRow, hook(5002)] : [hook(5002, { ppid: 1 })]),
      );
    },
  });
  await expect(reaper.sweepDetached(leaderNeverExits)).rejects.toThrow("process table unreadable");
  await vi.advanceTimersByTimeAsync(BACKGROUND_REAP_RETRY_MS * 2);
  expect(fake.calls).toEqual([`stop ${LEADER}`]);
  expect(() => reaper.reapAndThrowOnDetachedSweepFailure()).toThrow("process table unreadable");
});

test("C-LIFE-14 a failed survivor watch hands its actual record to background recovery", async () => {
  vi.useFakeTimers();
  let exited = false;
  let mayStop = false;
  const fake = scripted([]);
  const reaper = new SessionReaper(LEADER, {
    ...fake.ops,
    listProcesses: () =>
      Promise.resolve(fake.asRead(exited ? [hook(5002, { ppid: 1 })] : [leaderRow, hook(5002)])),
    listProcessesUnreferenced: () =>
      Promise.resolve(
        fake.asRead(fake.calls.includes("kill 5002") ? [] : [hook(5002, { ppid: 1 })]),
      ),
    stopGroup: (group: number) => {
      if (!mayStop) throw errno("EPERM");
      fake.ops.stopGroup(group);
    },
  });
  const watch = reaper.watchSurvivors(() => exited);
  await watch.firstRead;
  exited = true;
  await expect(watch.finish()).rejects.toThrow("could not stop a live descendant group");
  await vi.advanceTimersByTimeAsync(0);
  expect(() => reaper.reapAndThrowOnDetachedSweepFailure()).toThrow("could not stop");
  mayStop = true;
  await vi.advanceTimersByTimeAsync(BACKGROUND_REAP_RETRY_MS * 2);
  expect(fake.calls).toContain("kill 5002");
  expect(() => reaper.reapAndThrowOnDetachedSweepFailure()).not.toThrow();
});

test("C-LIFE-14 a standalone background reap uses its own pass without a session queue", async () => {
  vi.useFakeTimers();
  const record = new DescendantRecord();
  record.observe([leaderRow, hook(5002)], LEADER);
  const { ops } = scripted([[]]);
  const reap = reapInBackground(record, ops);
  await vi.advanceTimersByTimeAsync(0);
  expect(reap.resolved()).toBe(true);
});

test.each([
  0,
  1,
  process.pid,
])("C-LIFE-14 an unreapable leader %s starts no foreground or background pass", async (pid) => {
  const { ops, calls } = scripted([]);
  const reaper = new SessionReaper(pid, ops);
  await reaper.sweepDetached(leaderNeverExits);
  const watch = reaper.watchSurvivors(() => true);
  await watch.firstRead;
  await watch.finish();
  reaper.reapAndThrowOnDetachedSweepFailure();
  expect(calls).toEqual([]);
});
