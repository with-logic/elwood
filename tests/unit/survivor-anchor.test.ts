/** Identity checks after stopping a survivor group (PRD §5.3, C-LIFE-10). */
import { afterEach, expect, test, vi } from "vitest";
import { DescendantRecord } from "../../src/runtime/shutdown/detached-sweep/record.ts";
import { reapRecordedSurvivors } from "../../src/runtime/shutdown/detached-sweep/survivors.ts";
import {
  errno,
  hook,
  LEADER,
  leaderRow,
  scripted,
  ticking,
} from "../helpers/scripted-process-tree.ts";

const CHILD = 10_000_001;
const original = hook(CHILD, { ppid: 1 });
const replacement = hook(CHILD, { ppid: 1, startedAt: "Sun Oct 25 22:00:09 2026" });
const recorded = () => {
  const record = new DescendantRecord();
  record.observe([leaderRow, hook(CHILD)], LEADER);
  return record;
};
afterEach(() => vi.restoreAllMocks());

test("C-LIFE-10 a recycled PGID after SIGSTOP is resumed, never killed", async () => {
  const { ops, calls } = scripted([[original], [replacement]]);
  const failure = await reapRecordedSurvivors(recorded(), ops);
  expect(failure?.message).toContain("survivor group lost its identity anchor");
  expect(calls).toEqual(["list", `stop ${CHILD}`, "list", `cont ${CHILD}`]);
});

test("C-LIFE-10 an absent post-stop anchor fails without killing even when SIGCONT gets ESRCH", async () => {
  const { ops, calls } = scripted([[original], []], {
    continueGroup: () => {
      throw errno("ESRCH");
    },
  });
  expect((await reapRecordedSurvivors(recorded(), ops))?.processGroupIds).toEqual([CHILD]);
  expect(calls).not.toContain(`kill ${CHILD}`);
});

test("C-LIFE-10 a failed mismatched-group restoration retains the fresh stopped identities", async () => {
  const record = recorded();
  const { ops } = scripted([[original], [replacement]], {
    continueGroup: () => {
      throw errno("EPERM");
    },
  });
  expect((await reapRecordedSurvivors(record, ops))?.message).toContain(
    "could not resume an unconfirmed survivor group",
  );
  const table = [{ ...replacement, stopped: true }];
  expect(record.resumes.retry(table, ops)).toBe(false);
  const resume = vi.fn();
  expect(record.resumes.retry(table, { continueGroup: resume })).toBe(true);
  expect(resume).toHaveBeenCalledWith(CHILD);
});

test("C-LIFE-10 an unreadable post-stop table restores the unconfirmed group instead of killing", async () => {
  const fake = scripted([[original]]);
  let reads = 0;
  const failure = await reapRecordedSurvivors(recorded(), {
    ...fake.ops,
    listProcesses: (ms) =>
      ++reads === 1 ? fake.ops.listProcesses(ms) : Promise.reject(errno("EIO")),
  });
  expect(failure?.message).toContain("process table unreadable");
  expect(fake.calls).toEqual(["list", `stop ${CHILD}`, `cont ${CHILD}`]);
});

test("C-LIFE-10 a failed restoration without a post-stop read stays unresolved", async () => {
  const record = recorded();
  const fake = scripted([[original]], {
    continueGroup: () => {
      throw errno("EPERM");
    },
  });
  let reads = 0;
  await reapRecordedSurvivors(record, {
    ...fake.ops,
    listProcesses: (ms) =>
      ++reads === 1 ? fake.ops.listProcesses(ms) : Promise.reject(errno("EIO")),
  });
  expect(record.canReapInBackground([])).toBe(false);
});

test("C-LIFE-10 a survivor not confirmed stopped by the deadline is resumed", async () => {
  const fake = scripted([], { listProcesses: () => Promise.resolve([original]) });
  const failure = await reapRecordedSurvivors(recorded(), ticking(fake.ops), 250);
  expect(failure?.message).toContain("process groups not confirmed stopped by the deadline");
  expect(fake.calls).not.toContain(`kill ${CHILD}`);
  expect(fake.calls).toContain(`cont ${CHILD}`);
});
