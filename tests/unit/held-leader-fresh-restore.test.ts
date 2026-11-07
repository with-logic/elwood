/** Only fresh original member evidence restores a graceful hold (PRD §5.3, C-LIFE-10). */
import { afterEach, expect, test, vi } from "vitest";
import { heldLeader } from "../helpers/held-leader.ts";
import { errno, hook, LEADER, leaderRow, scripted } from "../helpers/scripted-process-tree.ts";

afterEach(() => vi.restoreAllMocks());
const member = hook(5001, { pgid: LEADER });
const held = [
  { ...leaderRow, stopped: true },
  { ...member, stopped: true },
];

test.each([
  {
    reason: "replacement",
    table: [{ ...leaderRow, startedAt: "Sun Oct 25 22:00:09 2026", stopped: true }],
    outcome: "signal-sent",
  },
  { reason: "empty", table: [], outcome: "leader-group-gone" },
])("C-LIFE-10 a $reason group after synchronous TERM exit receives no CONT", async ({
  table,
  outcome,
}) => {
  const fake = scripted([held, table]);
  const run = heldLeader(fake.ops);
  let exited = false;
  run.signal.leaderExited = () => exited;
  run.signal.send = () => {
    exited = true;
    run.delivered.push("TERM");
  };
  await expect(run.run()).resolves.toBe(outcome);
  expect(run.delivered).toEqual(["TERM"]);
  expect(fake.calls).not.toContain(`cont ${LEADER}`);
});

test("C-LIFE-10 an original held helper restores its group after the leader exits", async () => {
  const fake = scripted([held, [{ ...member, ppid: 1, stopped: true }]]);
  const run = heldLeader(fake.ops);
  await expect(run.run()).resolves.toBe("signal-sent");
  expect(fake.calls).toEqual([`stop ${LEADER}`, "list", "list", `cont ${LEADER}`]);
  expect(run.record.resumes.pids).toEqual([]);
});

test("C-LIFE-10 an unreadable post-TERM restoration keeps only original member debt", async () => {
  const readError = errno("EIO");
  const read = vi.fn().mockResolvedValueOnce(held).mockRejectedValueOnce(readError);
  const fake = scripted([], { listProcesses: read });
  const run = heldLeader(fake.ops);
  await expect(run.run()).rejects.toBe(readError);
  expect(fake.calls).not.toContain(`cont ${LEADER}`);
  expect(run.record.hasUnknownResume).toBe(true);
  expect(run.record.resumes.pids).toEqual([LEADER, member.pid]);
});

test("C-LIFE-10 restoration cannot use the pre-TERM snapshot after its deadline", async () => {
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const fake = scripted([held]);
  const run = heldLeader(fake.ops);
  run.signal.send = () => {
    clock = 10_001;
  };
  await expect(run.run()).rejects.toMatchObject({ code: "ETIMEDOUT" });
  expect(fake.calls).not.toContain(`cont ${LEADER}`);
  expect(run.record.hasUnknownResume).toBe(true);
  expect(run.record.resumes.pids).toEqual([LEADER, member.pid]);
});

test("C-LIFE-10 an already running original member needs no CONT", async () => {
  const read = vi.fn().mockResolvedValueOnce(held).mockResolvedValueOnce([leaderRow]);
  const fake = scripted([], { listProcesses: read });
  const run = heldLeader(fake.ops);
  await expect(run.run()).resolves.toBe("signal-sent");
  expect(fake.calls).not.toContain(`cont ${LEADER}`);
});

test("C-LIFE-10 late restoration read results cannot authorize CONT", async () => {
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const read = vi
    .fn()
    .mockResolvedValueOnce(held)
    .mockImplementationOnce(() => {
      clock = 10_001;
      return Promise.resolve(held);
    });
  const fake = scripted([], { listProcesses: read });
  const run = heldLeader(fake.ops);
  await expect(run.run()).rejects.toMatchObject({ code: "ETIMEDOUT" });
  expect(fake.calls).not.toContain(`cont ${LEADER}`);
  expect(run.record.resumes.pids).toEqual([LEADER, member.pid]);
});

test("C-LIFE-10 CONT EPERM can confirm an original running helper after leader exit", async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce(held)
    .mockResolvedValueOnce([{ ...member, ppid: 1, stopped: true }])
    .mockResolvedValueOnce([{ ...member, ppid: 1 }]);
  const resume = vi.fn(() => {
    throw errno("EPERM");
  });
  const run = heldLeader(scripted([], { listProcesses: read, continueGroup: resume }).ops);
  await expect(run.run()).resolves.toBe("signal-sent");
  expect(resume).toHaveBeenCalledExactlyOnceWith(LEADER);
  expect(run.record.resumes.pids).toEqual([]);
});

test.each([
  {
    reason: "known",
    owned: [member],
    survivor: member,
    continued: [LEADER],
    debt: [],
    unknown: false,
  },
  { reason: "unowned", owned: [], survivor: member, continued: [], debt: [LEADER], unknown: true },
  {
    reason: "ambiguous",
    owned: [{ ...member, startedAt: "Sun Oct 25 22:00:01 2026" }],
    survivor: { ...member, startedAt: "Sun Oct 25 22:00:01 2026" },
    continued: [],
    debt: [LEADER],
    unknown: true,
  },
])("C-LIFE-10 verification losing its leader restores only a $reason member", async ({
  owned,
  survivor,
  continued,
  debt,
  unknown,
}) => {
  const fake = scripted([[{ ...survivor, ppid: 1, stopped: true }]]);
  const run = heldLeader(fake.ops);
  run.record.observeLeaderGroup(
    [leaderRow, ...owned],
    LEADER,
    Date.parse(`${leaderRow.startedAt} UTC`) + 1_001,
  );
  await expect(run.run()).rejects.toThrow("not confirmed held");
  expect(
    fake.calls.filter((call) => call.startsWith("cont ")).map((call) => Number(call.split(" ")[1])),
  ).toEqual(continued);
  expect(run.record.resumes.pids).toEqual(debt);
  expect(run.record.hasUnknownResume).toBe(unknown);
});
