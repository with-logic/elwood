/** Confirms Darwin CONT refusals against one fresh bounded table (PRD §5.3, C-LIFE-10). */
import { afterEach, expect, test, vi } from "vitest";
import type { ProcessEntry } from "../../src/runtime/shutdown/process-table.ts";
import { heldLeader } from "../helpers/held-leader.ts";
import { errno, LEADER, leaderRow, scripted } from "../helpers/scripted-process-tree.ts";

afterEach(() => vi.restoreAllMocks());

function refusedResume(
  table: readonly ProcessEntry[] | Error,
  code = "EPERM",
  held: readonly ProcessEntry[] = [{ ...leaderRow, stopped: true }],
) {
  const error = errno(code);
  const read = vi.fn().mockResolvedValueOnce(held);
  if (table instanceof Error) read.mockRejectedValue(table);
  else read.mockResolvedValue(table);
  const resume = vi.fn(() => {
    throw error;
  });
  const run = heldLeader(scripted([], { listProcesses: read, continueGroup: resume }).ops);
  return { run, read, resume, error };
}

test.each([
  { table: [leaderRow], outcome: "signal-sent", gone: false },
  { table: [], outcome: "leader-group-gone", gone: true },
  { table: [{ ...leaderRow, zombie: true }], outcome: "leader-group-gone", gone: true },
])("C-LIFE-10 fresh restoration evidence accepts a running original or empty group (%#)", async ({
  table,
  outcome,
  gone,
}) => {
  const { run, read, resume } = refusedResume(table);
  await expect(run.run()).resolves.toBe(outcome);
  expect(run.groupGone()).toBe(gone);
  expect(run.delivered).toEqual(["TERM"]);
  expect(run.record.resumes.pids).toEqual([]);
  expect(read).toHaveBeenCalledTimes(2);
  expect(resume).toHaveBeenCalledTimes(1);
});

test.each([
  { table: [{ ...leaderRow, stopped: true }] },
  { table: [{ ...leaderRow, startedAt: "Sun Oct 25 22:00:09 2026" }] },
  { table: [{ ...leaderRow, pid: LEADER + 1 }] },
  {
    table: [
      { ...leaderRow, pgid: LEADER + 1 },
      { ...leaderRow, pid: LEADER + 2 },
    ],
  },
  {
    table: [
      { ...leaderRow, zombie: true },
      { ...leaderRow, pid: LEADER + 2 },
    ],
  },
])("C-LIFE-10 inconclusive restoration preserves refusal and original debt (%#)", async ({
  table,
}) => {
  const { run, read, resume, error } = refusedResume(table);
  await expect(run.run()).rejects.toBe(error);
  expect(run.groupGone()).toBe(false);
  expect(run.record.resumes.pids).toEqual([LEADER]);
  expect(read).toHaveBeenCalledTimes(2);
  expect(resume).toHaveBeenCalledTimes(1);
});

test("C-LIFE-10 an unreadable restoration confirmation preserves both errors", async () => {
  const readError = errno("EIO");
  const { run, error } = refusedResume(readError);
  await expect(run.run()).rejects.toMatchObject({ errors: [error, readError], code: "EPERM" });
  expect(run.record.resumes.pids).toEqual([LEADER]);
  expect(run.groupGone()).toBe(false);
});

test.each([
  false,
  true,
])("C-LIFE-10 restoration confirmation cannot outlive its deadline (%s)", async (late) => {
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const { run, read, resume, error } = refusedResume([leaderRow]);
  resume.mockImplementation(() => {
    clock = late ? 4_000 : 10_001;
    throw error;
  });
  if (late)
    read
      .mockReset()
      .mockResolvedValueOnce([{ ...leaderRow, stopped: true }])
      .mockImplementationOnce(() => {
        clock = 10_001;
        return Promise.resolve([leaderRow]);
      });
  await expect(run.run()).rejects.toMatchObject({ errors: [error, { code: "ETIMEDOUT" }] });
  expect(read).toHaveBeenCalledTimes(late ? 2 : 1);
  if (late) expect(read.mock.calls[1]).toEqual([6_000]);
  expect(run.record.resumes.pids).toEqual([LEADER]);
  expect(run.groupGone()).toBe(false);
});

test("C-LIFE-10 another CONT failure does not trigger a confirmation read", async () => {
  const { run, read, error } = refusedResume([leaderRow], "EIO");
  await expect(run.run()).rejects.toBe(error);
  expect(read).toHaveBeenCalledTimes(1);
  expect(run.record.resumes.pids).toEqual([LEADER]);
});

test("C-LIFE-10 confirmed restoration preserves the independent TERM failure", async () => {
  const { run } = refusedResume([leaderRow]);
  const termError = errno("EIO");
  run.signal.send = () => {
    throw termError;
  };
  await expect(run.run()).rejects.toBe(termError);
  expect(run.record.resumes.pids).toEqual([]);
});

test("C-LIFE-10 a running leader cannot clear another original member's stopped hold", async () => {
  const member = { ...leaderRow, pid: LEADER + 1, stopped: true };
  const fresh = [leaderRow, member];
  const { run, read, resume, error } = refusedResume(fresh, "EPERM", [
    { ...leaderRow, stopped: true },
    member,
  ]);
  await expect(run.run()).rejects.toBe(error);
  expect(run.groupGone()).toBe(false);
  expect(run.record.resumes.pids).toEqual([LEADER, member.pid]);
  expect(read).toHaveBeenCalledTimes(2);
  expect(resume).toHaveBeenCalledTimes(1);
  const continueGroup = vi.fn();
  expect(run.record.resumes.retry(fresh, { continueGroup })).toBe(true);
  expect(continueGroup).toHaveBeenCalledExactlyOnceWith(LEADER);
});
