/** Live recovery ownership and terminal signal safety (PRD §9.4, C-LIFE-14). */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SessionReapPolicy } from "../../src/runtime/session/reap.ts";
import { BACKGROUND_REAP_RETRY_WINDOW_MS } from "../../src/runtime/shutdown/detached-sweep/background.ts";
import {
  resetProcessTreeOpsForTests,
  setProcessTreeOpsForTests,
} from "../../src/runtime/shutdown/process-tree-ops.ts";
import { SessionReaper } from "../../src/runtime/shutdown/reap-tree.ts";
import {
  errno,
  hook,
  LEADER,
  leaderNeverExits,
  leaderRow,
  scripted,
  useScriptedHost,
} from "../helpers/scripted-process-tree.ts";

useScriptedHost();
let clock = 0;
beforeEach(() => {
  vi.useFakeTimers();
  clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetProcessTreeOpsForTests();
});

test("C-LIFE-14 forced records recover automatically while their original attempt rejects", async () => {
  const fake = scripted([]);
  let reads = 0;
  const gate = Promise.withResolvers<void>();
  const reaper = new SessionReaper(LEADER, {
    ...fake.ops,
    listProcesses: () =>
      ++reads === 1
        ? Promise.resolve(fake.asRead([leaderRow, hook(5002)]))
        : Promise.reject(errno("EIO")),
    listProcessesUnreferenced: async () => {
      await gate.promise;
      return [];
    },
  });
  await expect(reaper.sweepDetached(leaderNeverExits)).rejects.toThrow("process table unreadable");
  expect(() => reaper.reapAndThrowOnDetachedSweepFailure()).toThrow("process table unreadable");
  gate.resolve();
  await vi.advanceTimersByTimeAsync(0);
  await expect(
    Promise.resolve().then(() => reaper.reapAndThrowOnDetachedSweepFailure()),
  ).resolves.toBeUndefined();
  expect(fake.calls.filter((call) => call === `kill ${LEADER}`)).toHaveLength(1);
});

test("C-LIFE-14 expired confirmation is awaited and keeps read gaps, while terminal checks start no reads", async () => {
  const fake = scripted([]);
  let reads = 0;
  let gone = false;
  let unreadable = false;
  setProcessTreeOpsForTests({
    ...fake.ops,
    listProcesses: () => {
      reads += 1;
      if (reads === 2 || unreadable) return Promise.reject(errno("EIO"));
      return Promise.resolve(
        fake.asRead(reads === 1 ? [leaderRow, hook(5002)] : gone ? [] : [hook(5002, { ppid: 1 })]),
      );
    },
    listProcessesUnreferenced: () => Promise.resolve([hook(5002, { ppid: 1 })]),
    stopGroup: (group) => {
      if (group === 5002) throw errno("EIO");
      fake.ops.stopGroup(group);
    },
  });
  const policy = new SessionReapPolicy("codex", "retained", LEADER);
  await expect(policy.reaper.sweepDetached(leaderNeverExits)).rejects.toThrow();
  policy.reaper.reap();
  clock = BACKGROUND_REAP_RETRY_WINDOW_MS;
  const before = reads;
  expect(() =>
    policy.reaper.signalLeaderPty(() => {
      throw new Error("stale signal");
    }),
  ).toThrow("process table unreadable");
  await vi.advanceTimersByTimeAsync(0);
  expect(reads).toBe(before);
  await expect(Promise.resolve().then(() => policy.orThrow())).rejects.toMatchObject({
    code: "termination_failed",
  });
  gone = true;
  unreadable = true;
  await expect(Promise.resolve().then(() => policy.orThrow())).rejects.toMatchObject({
    code: "termination_failed",
  });
  unreadable = false;
  await expect(Promise.resolve().then(() => policy.orThrow())).rejects.toMatchObject({
    code: "termination_failed",
  });
  expect(fake.calls.filter((call) => call === `kill ${LEADER}`)).toHaveLength(1);
  expect(fake.calls).not.toContain("stop 5002");
});

test("C-LIFE-14 graceful restoration debt retires the leader owner on recovery CONT ESRCH", async () => {
  const fake = scripted([]);
  let resumes = 0;
  let terminalSignalIndex = -1;
  let exited = false;
  const reaper = new SessionReaper(LEADER, {
    ...fake.ops,
    listProcesses: () => Promise.resolve(fake.asRead([leaderRow])),
    continueGroup: () => {
      resumes += 1;
      fake.calls.push(`cont ${LEADER}`);
      if (resumes === 3) terminalSignalIndex = fake.calls.length;
      throw errno(resumes < 3 ? "EPERM" : "ESRCH");
    },
  });
  const watch = reaper.watchSurvivors(() => exited);
  await watch.firstObservation;
  await expect(
    watch.sendSignal(() => {
      exited = true;
    }),
  ).rejects.toMatchObject({ code: "EPERM" });
  await expect(watch.finish()).rejects.toThrow("unresolved restoration");
  await vi.advanceTimersByTimeAsync(0);
  expect(resumes).toBe(3);
  const sent = vi.fn();
  expect(reaper.signalLeaderPty(sent)).toBe("leader-group-gone");
  reaper.reap();
  await reaper.sweepDetached(leaderNeverExits);
  expect(sent).not.toHaveBeenCalled();
  expect(fake.calls[0]).toBe(`stop ${LEADER}`);
  expect(
    fake.calls.slice(0, terminalSignalIndex).filter((call) => call.startsWith("cont ")),
  ).toHaveLength(3);
  expect(fake.calls.slice(terminalSignalIndex)).toEqual([]);
});

test("C-LIFE-14 a second unknown record keeps the original failure after known records resolve", async () => {
  const fake = scripted([]);
  let reads = 0;
  const reaper = new SessionReaper(LEADER, {
    ...fake.ops,
    listProcesses: () => {
      reads += 1;
      if (reads === 1) return Promise.resolve(fake.asRead([leaderRow, hook(5002)]));
      if (reads < 4) return Promise.reject(errno("EIO"));
      return Promise.resolve([]);
    },
    listProcessesUnreferenced: () => Promise.resolve([hook(5002, { ppid: 1 })]),
    stopGroup: (group) => {
      if (group === 5002) throw errno("EIO");
      fake.ops.stopGroup(group);
    },
  });
  const original = await reaper.sweepDetached(leaderNeverExits).catch((error: unknown) => error);
  await expect(reaper.sweepDetached(leaderNeverExits)).rejects.toThrow();
  reaper.reap();
  clock = BACKGROUND_REAP_RETRY_WINDOW_MS;
  // The known record disappears; the second failed walk captured no identity.
  await expect(
    Promise.resolve().then(() => reaper.reapAndThrowOnDetachedSweepFailure()),
  ).rejects.toBe(original);
});
