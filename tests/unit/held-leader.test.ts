/** Fresh original stopped identity alone authorizes graceful TERM (PRD §5.3, C-LIFE-10). */
import { afterEach, expect, test, vi } from "vitest";
import { heldLeader } from "../helpers/held-leader.ts";
import { errno, LEADER, leaderRow, scripted } from "../helpers/scripted-process-tree.ts";

afterEach(() => vi.restoreAllMocks());

test("C-LIFE-10 TERM is delivered only after holding and verifying the original leader", async () => {
  const fake = scripted([[leaderRow]]);
  const run = heldLeader(fake.ops);
  await expect(run.run()).resolves.toBe("signal-sent");
  expect(run.delivered).toEqual(["TERM"]);
  expect(run.refused).toEqual([]);
  expect(fake.calls).toEqual([`stop ${LEADER}`, "list", `cont ${LEADER}`]);
});

test.each([
  { ...leaderRow, startedAt: "Sun Oct 25 22:00:09 2026", stopped: true },
  { ...leaderRow, pgid: LEADER + 1, stopped: true },
  { ...leaderRow, stopped: false },
  { ...leaderRow, pid: LEADER + 1, stopped: true },
  { ...leaderRow, zombie: true, stopped: true },
])("C-LIFE-10 a changed or running leader %j receives no TERM or CONT", async (row) => {
  const continueGroup = vi.fn(() => {
    throw errno("EPERM");
  });
  const fake = scripted([], {
    listProcesses: () => Promise.resolve([row, { ...leaderRow, pid: LEADER + 2 }]),
    continueGroup,
  });
  const run = heldLeader(fake.ops);
  await expect(run.run()).rejects.toThrow("not confirmed held");
  expect(run.delivered).toEqual([]);
  expect(run.refused).toHaveLength(1);
  expect(fake.calls).toEqual([`stop ${LEADER}`]);
  expect.soft(continueGroup).not.toHaveBeenCalled();
  expect.soft(run.record.resumes.pids).toEqual([]);
  expect(run.record.hasUnknownResume).toBe(false);
  expect.soft(run.record.resumes.retry([row], { continueGroup })).toBe(true);
  expect.soft(continueGroup).not.toHaveBeenCalled();
});

test.each([
  { table: [] },
  { table: [{ ...leaderRow, zombie: true }] },
])("C-LIFE-10 a fresh empty leader group cancels TERM and restoration (%#)", async ({ table }) => {
  const fake = scripted([table]);
  const run = heldLeader(fake.ops);
  await expect(run.run()).resolves.toBe("leader-group-gone");
  expect(run.groupGone()).toBe(true);
  expect(run.delivered).toEqual([]);
  expect(fake.calls).toEqual([`stop ${LEADER}`, "list"]);
});

test.each(["ESRCH", "EPERM"])("C-LIFE-10 %s with an empty group proves it gone", async (code) => {
  const fake = scripted([[]], {
    stopGroup: () => {
      throw errno(code);
    },
  });
  const run = heldLeader(fake.ops);
  await expect(run.run()).resolves.toBe("leader-group-gone");
  expect(run.groupGone()).toBe(true);
  expect(run.delivered).toEqual([]);
});

test.each(["EPERM", "EIO"])("C-LIFE-10 a refused stop %s never delivers TERM", async (code) => {
  const failure = errno(code);
  const fake = scripted([[leaderRow]], {
    stopGroup: () => {
      throw failure;
    },
  });
  const run = heldLeader(fake.ops);
  await expect(run.run()).rejects.toBe(failure);
  expect(run.refused).toEqual([failure]);
  expect(run.delivered).toEqual([]);
  expect(fake.calls).not.toContain(`cont ${LEADER}`);
});

test("C-LIFE-10 deadline expiry before SIGSTOP has no signal effects", async () => {
  const fake = scripted([[leaderRow]]);
  const run = heldLeader(fake.ops);
  run.signal.deadline = 0;
  await expect(run.run()).rejects.toMatchObject({ code: "ETIMEDOUT" });
  expect(run.delivered).toEqual([]);
  expect(fake.calls).toEqual([]);
});

test("C-LIFE-10 verification spends only the deadline remaining after admission", async () => {
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const fake = scripted([[leaderRow]], {
    stopGroup: () => {
      clock = 4_000;
    },
  });
  const run = heldLeader(fake.ops);
  await run.run();
  expect(fake.timeouts).toEqual([6_000]);
});

test("C-LIFE-10 expiry during the fresh read restores the hold without TERM", async () => {
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const fake = scripted([], {
    listProcesses: () => {
      clock = 10_001;
      return Promise.resolve([{ ...leaderRow, stopped: true }]);
    },
  });
  const run = heldLeader(fake.ops);
  await expect(run.run()).rejects.toMatchObject({ code: "ETIMEDOUT" });
  expect(run.delivered).toEqual([]);
  expect(fake.calls).toContain(`cont ${LEADER}`);
});
