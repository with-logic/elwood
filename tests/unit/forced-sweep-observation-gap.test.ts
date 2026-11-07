/** An incomplete forced walk cannot certify an unseen orphan gone (C-LIFE-10). */
import { afterEach, expect, test, vi } from "vitest";
import { reapInBackground } from "../../src/runtime/shutdown/detached-sweep/background.ts";
import { sweepDetachedGroups } from "../../src/runtime/shutdown/detached-sweep/index.ts";
import { DescendantRecord } from "../../src/runtime/shutdown/detached-sweep/record.ts";
import type { ProcessEntry } from "../../src/runtime/shutdown/process-table.ts";
import { serializedReapQueue } from "../helpers/reap-queue.ts";
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
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function recoverWithOrphan(record: DescendantRecord, orphan: ProcessEntry) {
  const remaining = scripted([[orphan]]);
  const recovery = reapInBackground(record, remaining.ops, serializedReapQueue());
  await vi.advanceTimersByTimeAsync(0);
  return {
    resolved: recovery.resolved(),
    calls: remaining.calls,
    survivors: record.survivors([orphan]),
  };
}

test("C-LIFE-10 a child forked during a failed forced-walk read cannot be forgotten", async () => {
  vi.useFakeTimers();
  const record = new DescendantRecord();
  const first = [leaderRow, hook(5002)];
  const reading = Promise.withResolvers<void>();
  const gap = Promise.withResolvers<readonly ProcessEntry[]>();
  let reads = 0;
  const fake = scripted([], {
    listProcesses: () => {
      reads += 1;
      if (reads === 1) return Promise.resolve(fake.asRead(first));
      reading.resolve();
      return gap.promise;
    },
  });
  const pending = sweepDetachedGroups(
    LEADER,
    fake.ops,
    leaderNeverExits,
    undefined,
    undefined,
    record,
  );
  await reading.promise;
  // The unstopped hook forks, then exits; the unreadable snapshot loses its parent link.
  const forked = hook(5003, { ppid: 1 });
  gap.reject(errno("EIO"));
  expect(await pending).toMatchObject({
    message: expect.stringContaining("process table unreadable (EIO)"),
    code: "EIO",
  });
  expect(record.known).toBe(true);
  expect(record.pids).toEqual([5002]);
  expect(await recoverWithOrphan(record, forked)).toEqual({
    resolved: false,
    calls: ["list"],
    survivors: [],
  });
  expect(record.hasObservationUncertainty).toBe(true);
});

test.each([
  {
    kind: "deadline",
    reason: "process groups not confirmed stopped by the deadline",
    readClock: 10,
    exitAfterReads: Number.POSITIVE_INFINITY,
  },
  {
    kind: "leader exit",
    reason: "the leader exited before every group was confirmed stopped",
    readClock: 0,
    exitAfterReads: 1,
  },
])("C-LIFE-10 an incomplete forced-walk $kind retains observation uncertainty", async ({
  reason,
  readClock,
  exitAfterReads,
}) => {
  vi.useFakeTimers();
  let clock = 0;
  let reads = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const record = new DescendantRecord();
  const fake = scripted([], {
    listProcesses: () => {
      reads += 1;
      clock = readClock;
      return Promise.resolve(fake.asRead([leaderRow, hook(5002)]));
    },
  });
  const failure = await sweepDetachedGroups(
    LEADER,
    fake.ops,
    () => reads >= exitAfterReads,
    10,
    undefined,
    record,
  );
  expect(failure).toMatchObject({ message: `Could not reap process-tree groups: ${reason}` });
  expect(record.known).toBe(true);
  expect(record.pids).toEqual([5002]);
  expect(await recoverWithOrphan(record, hook(5003, { ppid: 1 }))).toEqual({
    resolved: false,
    calls: ["list"],
    survivors: [],
  });
  expect(record.hasObservationUncertainty).toBe(true);
});

test("C-LIFE-10 a fully observed group KILL failure does not create an observation gap", async () => {
  vi.useFakeTimers();
  const record = new DescendantRecord();
  const fake = scripted([[leaderRow, hook(5002)]], {
    killGroup: () => {
      throw errno("EIO");
    },
  });
  expect(
    await sweepDetachedGroups(LEADER, fake.ops, leaderNeverExits, undefined, undefined, record),
  ).toMatchObject({
    message: expect.stringContaining("could not kill a signaled descendant group"),
  });
  expect(record.hasObservationUncertainty).toBe(false);
  const remaining = scripted([[]]);
  const recovery = reapInBackground(record, remaining.ops, serializedReapQueue());
  await vi.advanceTimersByTimeAsync(0);
  expect(recovery.resolved()).toBe(true);
});
