/** Held-leader refusals and restoration debt preserve every failure (PRD §5.3, C-LIFE-10). */
import { expect, test, vi } from "vitest";
import {
  authorizationError,
  pendingRestorationCases,
  priorRefusalCases,
  signalFailureCases,
} from "../fixtures/held-leader/cases.ts";
import { heldLeader } from "../helpers/held-leader.ts";
import { errno, LEADER, leaderRow, scripted } from "../helpers/scripted-process-tree.ts";

test.each([
  false,
  true,
])("C-LIFE-10 a refused first observation survives exit=%s without signals", async (exited) => {
  const fake = scripted([[leaderRow]]);
  const run = heldLeader(fake.ops);
  const error = errno("EIO");
  run.signal.observation = { kind: "refused", error };
  run.signal.leaderExited = () => exited;
  await expect(run.run()).rejects.toBe(error);
  expect(run.refused).toEqual([error]);
  expect(fake.calls).toEqual([]);
  expect(run.delivered).toEqual([]);
});

test.each(priorRefusalCases)("C-LIFE-10 prior $reason forbids even a leader SIGSTOP", async ({
  setup,
}) => {
  const fake = scripted([[leaderRow]]);
  const run = heldLeader(fake.ops);
  setup(run);
  await expect(run.run()).rejects.toBeInstanceOf(Error);
  expect(run.refused).toHaveLength(1);
  expect(fake.calls).toEqual([]);
  expect(run.delivered).toEqual([]);
});

test("C-LIFE-10 exit during verification restores only the already-sent hold", async () => {
  let exited = false;
  const fake = scripted([[leaderRow]], {
    stopGroup: () => {
      exited = true;
    },
  });
  const run = heldLeader(fake.ops);
  run.signal.leaderExited = () => exited;
  await expect(run.run()).rejects.toThrow("not confirmed held");
  expect(run.delivered).toEqual([]);
  expect(fake.calls).toEqual(["list", "list", `cont ${LEADER}`]);
});

test.each(
  pendingRestorationCases,
)("C-LIFE-10 a failed fresh read retains original debt for a safe retry (%#)", async ({
  row,
  done,
  calls,
  debt,
  afterStoppedCalls,
}) => {
  const error = errno("EIO");
  const fake = scripted([], { listProcesses: () => Promise.reject(error) });
  const run = heldLeader(fake.ops);
  await expect(run.run()).rejects.toBe(error);
  expect(fake.calls).toEqual([`stop ${LEADER}`]);
  expect(run.delivered).toEqual([]);
  expect(run.record.hasUnknownResume).toBe(true);
  expect(run.record.resumes.pids).toEqual([LEADER]);
  const continueGroup = vi.fn();
  expect(run.record.resumes.retry([row], { continueGroup })).toBe(done);
  expect(continueGroup.mock.calls).toEqual(calls);
  expect(run.record.resumes.pids).toEqual(debt);
  expect(run.record.resumes.retry([{ ...leaderRow, stopped: true }], { continueGroup })).toBe(true);
  expect(continueGroup.mock.calls).toEqual(afterStoppedCalls);
  expect(run.record.resumes.pids).toEqual([]);
  expect(run.record.hasUnknownResume).toBe(true);
});

test("C-LIFE-10 a failed known restoration retains original stopped identities for retry", async () => {
  const error = errno("EPERM");
  const fake = scripted([[leaderRow]], {
    continueGroup: () => {
      throw error;
    },
  });
  const run = heldLeader(fake.ops);
  await expect(run.run()).rejects.toBe(error);
  expect(run.delivered).toEqual(["TERM"]);
  expect(run.record.hasUnknownResume).toBe(false);
  expect(run.record.resumes.pids).toEqual([LEADER]);
  const resumed: number[] = [];
  expect(
    run.record.resumes.retry([{ ...leaderRow, stopped: true }], {
      continueGroup: (group) => {
        resumed.push(group);
      },
    }),
  ).toBe(true);
  expect(resumed).toEqual([LEADER]);
});

test("C-LIFE-10 an unreadable held group keeps unknown and failed original restoration debt", async () => {
  const readError = errno("EIO");
  const fake = scripted([], { listProcesses: () => Promise.reject(readError) });
  const run = heldLeader(fake.ops);
  await expect(run.run()).rejects.toBe(readError);
  const continueGroup = vi.fn(() => {
    throw errno("EPERM");
  });
  expect(run.record.resumes.retry([{ ...leaderRow, stopped: true }], { continueGroup })).toBe(
    false,
  );
  expect(continueGroup).toHaveBeenCalledWith(LEADER);
  expect(run.record.resumes.pids).toEqual([LEADER]);
  expect(run.record.hasUnknownResume).toBe(true);
  expect(run.delivered).toEqual([]);
});

test("C-LIFE-10 ESRCH at restoration confirms the whole group gone", async () => {
  const fake = scripted([[leaderRow]], {
    continueGroup: () => {
      throw errno("ESRCH");
    },
  });
  const run = heldLeader(fake.ops);
  await expect(run.run()).resolves.toBe("leader-group-gone");
  expect(run.groupGone()).toBe(true);
  expect(run.record.resumes.pids).toEqual([]);
});

test.each([
  new Error("TERM refused"),
  errno("EIO"),
])("C-LIFE-10 failed TERM and restoration preserve both causes (%s)", async (termError) => {
  const resumeError = errno("EPERM");
  const fake = scripted([[leaderRow]], {
    continueGroup: () => {
      throw resumeError;
    },
  });
  const run = heldLeader(fake.ops);
  run.signal.send = () => {
    throw termError;
  };
  const failed = await run.run().then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failed).toBeInstanceOf(AggregateError);
  if (!(failed instanceof AggregateError)) throw new Error("Expected both signal failures");
  expect(failed).toMatchObject({ errors: [termError, resumeError] });
  expect("code" in failed ? failed.code : undefined).toBe(
    "code" in termError ? termError.code : "code" in resumeError ? resumeError.code : undefined,
  );
  expect(run.refused).toEqual([]);
  expect(run.record.resumes.pids).toEqual([LEADER]);
});

test.each(
  signalFailureCases,
)("C-LIFE-10 failed $phase preserves its cause after restoring the hold", async ({
  setup,
  refused,
}) => {
  const fake = scripted([[leaderRow]]);
  const run = heldLeader(fake.ops);
  setup(run);
  await expect(run.run()).rejects.toBe(authorizationError);
  expect(fake.calls).toContain(`cont ${LEADER}`);
  expect(run.refused).toEqual(refused);
  expect(run.delivered).toEqual([]);
});

test("C-LIFE-10 refused STOP and unreadable confirmation preserve both causes", async () => {
  const stopped = errno("EPERM");
  const unreadable = errno("EIO");
  const run = heldLeader(
    scripted([], {
      stopGroup: () => {
        throw stopped;
      },
      listProcesses: () => Promise.reject(unreadable),
    }).ops,
  );
  await expect(run.run()).rejects.toMatchObject({
    code: "EPERM",
    errors: [stopped, unreadable],
    message: "raw EPERM detail; raw EIO detail",
  });
  expect(run.delivered).toEqual([]);
});
