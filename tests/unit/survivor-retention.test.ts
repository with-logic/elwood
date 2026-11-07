/** Recorded ownership and ambiguity survive later reads (PRD §5.3, C-LIFE-10). */
import { afterEach, expect, test, vi } from "vitest";
import { DescendantRecord } from "../../src/runtime/shutdown/detached-sweep/record.ts";
import { reapRecordedSurvivors } from "../../src/runtime/shutdown/detached-sweep/survivors.ts";
import { errno, hook, LEADER, leaderRow, scripted } from "../helpers/scripted-process-tree.ts";

const older = "Sun Oct 25 21:59:00 2026";
const epoch = Date.parse("2026-10-25T22:00:00.500Z");
afterEach(() => vi.restoreAllMocks());

test("C-LIFE-10 retain a newly owned child before another anchor fails and its parent exits", async () => {
  const parent = hook(5002, { ppid: 1 });
  const other = hook(5004, { ppid: 1 });
  const replacement = { ...other, startedAt: "Sun Oct 25 22:00:09 2026" };
  const child = hook(5003, { ppid: 5002 });
  const orphan = { ...child, ppid: 1 };
  const record = new DescendantRecord();
  record.observe([leaderRow, hook(5002), hook(5004)], LEADER);
  let retainedBeforeRestoration = false;
  const { ops, calls } = scripted([[parent, other], [parent, replacement, child], [orphan]], {
    continueGroup: (group) => {
      if (group === other.pgid) retainedBeforeRestoration = record.pids.includes(child.pid);
    },
    killGroup: (group) => {
      calls.push(`refused kill ${group}`);
      throw errno("EIO");
    },
  });
  expect(await reapRecordedSurvivors(record, ops)).toBeDefined();
  expect(retainedBeforeRestoration).toBe(true);
  expect(record.pids).toContain(child.pid);
  expect(calls).toContain("refused kill 5003");
  expect(calls).not.toContain("refused kill 5004");
  const retry = scripted([[orphan]]);
  expect(await reapRecordedSurvivors(record, retry.ops)).toBeUndefined();
  expect(retry.calls).toContain("kill 5003");
});

test.each([
  "Sun Oct 25 22:00:00 2026",
  "unparseable",
])("C-LIFE-10 ambiguous member %s vetoes only its group until its matching identity is gone", async (startedAt) => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(epoch);
  const record = new DescendantRecord();
  const safe = hook(5003, { startedAt: older });
  const ambiguous = hook(5002, { startedAt });
  record.observe([{ ...leaderRow, startedAt: older }, ambiguous, safe], LEADER);
  clock.mockReturnValue(epoch + 5_000);
  // A later observation must not convert the same ambiguous identity into authority.
  record.observe([{ ...leaderRow, startedAt: older }, ambiguous, safe], LEADER);
  const { ops, calls } = scripted([[ambiguous, safe]]);
  expect((await reapRecordedSurvivors(record, ops))?.processGroupIds).toEqual([5002]);
  expect(calls).not.toContain("stop 5002");
  expect(calls).toContain("kill 5003");
  expect(
    await reapRecordedSurvivors(record, scripted([[{ ...ambiguous, zombie: true }]]).ops),
  ).toBeUndefined();
  expect(await reapRecordedSurvivors(record, scripted([[]]).ops)).toBeUndefined();
  const reused = { ...ambiguous, startedAt: "Sun Oct 25 22:01:00 2026" };
  const replacement = scripted([[reused]]);
  expect(await reapRecordedSurvivors(record, replacement.ops)).toBeUndefined();
  expect(replacement.calls).toEqual(["list"]);
});

test("C-LIFE-10 an ambiguous parent cannot authorize a new child after the leader exited", async () => {
  const record = new DescendantRecord();
  const ambiguous = hook(5002);
  record.observe([{ ...leaderRow, startedAt: older }, ambiguous], LEADER, true, epoch);
  const child = hook(5003, { ppid: 5002, startedAt: "Sun Oct 25 22:00:01 2026" });
  vi.spyOn(Date, "now").mockReturnValue(epoch + 5_000);
  const fake = scripted([[{ ...ambiguous, ppid: 1 }, child]]);
  expect((await reapRecordedSurvivors(record, fake.ops))?.processGroupIds).toEqual([5002]);
  expect(record.pids).toEqual([5002]);
  expect(fake.calls).toEqual(["list"]);
});

test("C-LIFE-10 a newly observed child's ambiguity uses its process-read start epoch", async () => {
  const parent = hook(5002, { startedAt: older, ppid: 1 });
  const child = hook(5003, { ppid: 5002 });
  const record = new DescendantRecord();
  record.observe(
    [
      { ...leaderRow, startedAt: older },
      { ...parent, ppid: LEADER },
    ],
    LEADER,
  );
  const clock = vi.spyOn(Date, "now").mockReturnValue(epoch);
  const { ops, calls } = scripted([[parent, child]]);
  const failure = await reapRecordedSurvivors(record, {
    ...ops,
    listProcesses: (ms) => {
      clock.mockReturnValue(epoch + 5_000);
      return ops.listProcesses(ms);
    },
  });
  expect(failure?.processGroupIds).toEqual([5003]);
  expect(calls).not.toContain("stop 5003");
  expect(calls).toContain("kill 5002");
});

test("C-LIFE-10 an exact start-second boundary supplies distinguishable descendant identity", async () => {
  const child = hook(5002);
  const record = new DescendantRecord();
  record.observe([{ ...leaderRow, startedAt: older }, child], LEADER, true, epoch + 500);
  const { ops, calls } = scripted([[{ ...child, ppid: 1 }]]);
  expect(await reapRecordedSurvivors(record, ops)).toBeUndefined();
  expect(calls).toContain("kill 5002");
});
