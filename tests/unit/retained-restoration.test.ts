/** Retained restoration separates gone groups from moved original identities (C-LIFE-10). */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DescendantRecord } from "../../src/runtime/shutdown/detached-sweep/record.ts";
import { RetainedShutdownFailures } from "../../src/runtime/shutdown/detached-sweep/retained-failures.ts";
import type { ProcessEntry } from "../../src/runtime/shutdown/process-table.ts";
import { serializedReapQueue } from "../helpers/reap-queue.ts";
import {
  errno,
  hook,
  LEADER,
  leaderRow,
  scripted,
  useScriptedHost,
} from "../helpers/scripted-process-tree.ts";

useScriptedHost();
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const held = { ...leaderRow, stopped: true };
const failure = Object.assign(new Error("original cleanup failed"), { processGroupIds: [LEADER] });

async function restoration(table: readonly ProcessEntry[], continueGroup: () => void) {
  const record = new DescendantRecord();
  const original = [leaderRow, hook(5002, { pgid: LEADER })];
  record.observeFirst(original, LEADER, Date.now());
  record.observeLeaderGroup(original, LEADER, Date.now());
  record.resumes.remember([held], LEADER);
  const calls: string[] = [];
  const failures = new RetainedShutdownFailures(
    {
      ...scripted([]).ops,
      listProcesses: () => Promise.resolve([]),
      listProcessesUnreferenced: () => Promise.resolve(table),
      continueGroup: (group) => {
        calls.push(`cont ${group}`);
        continueGroup();
      },
      stopGroup: (group) => {
        calls.push(`stop ${group}`);
      },
      killGroup: (group) => {
        calls.push(`kill ${group}`);
      },
    },
    serializedReapQueue(),
  );
  let initialFailure: unknown;
  try {
    failures.keep(failure, record);
  } catch (error) {
    initialFailure = error;
  }
  await vi.advanceTimersByTimeAsync(0);
  return { failures, record, calls, initialFailure };
}

test("C-LIFE-10 retained CONT ESRCH resolves a conclusively gone group", async () => {
  const { failures, calls, initialFailure } = await restoration([held], () => {
    throw errno("ESRCH");
  });
  expect(initialFailure).toBe(failure);
  expect(() => failures.throwIfUnresolved()).not.toThrow();
  expect(calls).toEqual([`cont ${LEADER}`]);
});

test("C-LIFE-10 retained CONT EPERM remains unresolved", async () => {
  const { failures, calls, initialFailure } = await restoration([{ ...held, shared: true }], () => {
    throw errno("EPERM");
  });
  expect(initialFailure).toBe(failure);
  expect(() => failures.throwIfUnresolved()).toThrow(failure);
  expect(calls).toEqual([`cont ${LEADER}`]);
});

test("C-LIFE-10 successful retained CONT resolves restored shared members", async () => {
  const { failures, calls, initialFailure } = await restoration(
    [{ ...held, shared: true }],
    () => {},
  );
  expect(initialFailure).toBe(failure);
  expect(() => failures.throwIfUnresolved()).not.toThrow();
  expect(calls).toEqual([`cont ${LEADER}`]);
});

test("C-LIFE-10 retiring the original group keeps its recorded moved member eligible", async () => {
  const moved = hook(5002, { ppid: 1, stopped: true });
  const { record, calls, initialFailure } = await restoration([held, moved], () => {
    throw errno("ESRCH");
  });
  expect(initialFailure).toBe(failure);
  expect(calls).toContain(`cont ${LEADER}`);
  expect(record.survivors([held, moved])).toEqual([moved]);
  expect(calls).toContain("kill 5002");
});
