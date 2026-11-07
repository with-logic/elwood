/** Identity checks after stopping a survivor group (PRD §5.3, C-LIFE-10). */
import { afterEach, expect, test, vi } from "vitest";
import { DescendantRecord } from "../../src/runtime/shutdown/detached-sweep/record.ts";
import { reapRecordedSurvivors } from "../../src/runtime/shutdown/detached-sweep/survivors.ts";
import {
  errno,
  hook,
  LEADER,
  leaderRow,
  STARTED_AT,
  scripted,
} from "../helpers/scripted-process-tree.ts";

const CHILD = 10_000_001;
const OBSERVED_AT = Date.parse(`${STARTED_AT} UTC`) + 10_000;
const original = hook(CHILD, { ppid: 1 });
const replacement = hook(CHILD, { ppid: 1, startedAt: "Sun Oct 25 22:00:09 2026" });
const recorded = () => {
  const record = new DescendantRecord();
  record.observeFirst([leaderRow], LEADER, OBSERVED_AT);
  record.observe([leaderRow, hook(CHILD)], LEADER, OBSERVED_AT);
  return record;
};
afterEach(() => vi.restoreAllMocks());

test("C-LIFE-10 a recycled PGID after SIGSTOP is never resumed or killed", async () => {
  const { ops, calls } = scripted([[original, hook(CHILD + 1, { zombie: true })], [replacement]]);
  const failure = await reapRecordedSurvivors(recorded(), ops);
  expect(calls).not.toContain(`kill ${CHILD}`);
  expect(failure?.message).toContain("survivor group could not be safely confirmed stopped");
  expect(calls).toEqual(["list", `stop ${CHILD}`, "list"]);
});

test("C-LIFE-10 a replacement group never becomes restoration debt", async () => {
  const record = recorded();
  const fake = scripted([[original], [replacement]], {
    continueGroup: () => {
      throw errno("EPERM");
    },
  });
  expect(await reapRecordedSurvivors(record, fake.ops)).toBeDefined();
  expect(record.resumes.pids).toEqual([]);
  const resume = vi.fn();
  expect(record.resumes.retry([{ ...replacement, stopped: true }], { continueGroup: resume })).toBe(
    true,
  );
  expect(resume).not.toHaveBeenCalled();
});

test("C-LIFE-10 a failed restoration without a post-stop read stays unresolved", async () => {
  const record = recorded();
  const unverified = vi.fn(() => {
    throw errno("EPERM");
  });
  const fake = scripted([[original]], { continueGroup: unverified });
  let reads = 0;
  await reapRecordedSurvivors(record, {
    ...fake.ops,
    listProcesses: (ms) =>
      ++reads === 1 ? fake.ops.listProcesses(ms) : Promise.reject(errno("EIO")),
  });
  expect(record.hasUnknownResume).toBe(true);
  expect(unverified).not.toHaveBeenCalled();
  const resume = vi.fn();
  record.resumes.retry([{ ...original, stopped: true }], { continueGroup: resume });
  expect(resume).toHaveBeenCalledWith(CHILD);
  expect(await reapRecordedSurvivors(record, scripted([[]]).ops)).toBeDefined();
});

test("C-LIFE-10 an empty post-stop read leaves no numeric restoration debt", async () => {
  const record = recorded();
  const fake = scripted([[original], []]);
  expect(await reapRecordedSurvivors(record, fake.ops)).toBeDefined();
  expect(record.hasUnknownResume).toBe(false);
  expect(record.resumes.pids).toEqual([]);
  expect(fake.calls).not.toContain(`cont ${CHILD}`);
});

test("C-LIFE-10 unresolved restoration is retried independently of survivor ownership", async () => {
  const record = new DescendantRecord();
  record.observeFirst([leaderRow], LEADER, OBSERVED_AT);
  record.observe([leaderRow], LEADER, OBSERVED_AT);
  const stopped = { ...replacement, stopped: true, shared: true };
  record.resumes.remember([stopped], CHILD);
  const refused = scripted([[stopped]], {
    continueGroup: () => {
      throw errno("EPERM");
    },
  });
  expect(await reapRecordedSurvivors(record, refused.ops)).toMatchObject({
    code: "EPERM",
    processGroupIds: [CHILD],
  });
  expect(record.pids).toEqual([CHILD]);
  const recovered = scripted([[stopped]]);
  expect(await reapRecordedSurvivors(record, recovered.ops)).toBeUndefined();
  expect(recovered.calls).toEqual(["list", `cont ${CHILD}`]);
  expect(record.pids).toEqual([]);
});

test("C-LIFE-10 a daemon restoration failure retains identities for a later safe resume", async () => {
  const record = recorded();
  const daemon = { ...original, shared: true };
  const fake = scripted([[original], [daemon]], {
    continueGroup: () => {
      throw errno("EPERM");
    },
  });
  const failure = await reapRecordedSurvivors(record, fake.ops);
  expect(failure?.message).toContain("could not resume a group spared for Codex's shared daemon");
  expect(record.resumes.pids).toEqual([CHILD]);
  expect(fake.calls).not.toContain(`kill ${CHILD}`);
  const resumed = scripted([[{ ...daemon, stopped: true }]]);
  expect(await reapRecordedSurvivors(record, resumed.ops)).toBeUndefined();
  expect(resumed.calls).toEqual(["list", `cont ${CHILD}`]);
});

test("C-LIFE-10 a previously confirmed anchor must still read stopped before killing", async () => {
  const fake = scripted([]);
  const rows = [[original], [{ ...original, stopped: true }], [original]];
  let read = 0;
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const failure = await reapRecordedSurvivors(
    recorded(),
    {
      ...fake.ops,
      listProcesses: () => {
        clock += 100;
        return Promise.resolve(rows[Math.min(read++, rows.length - 1)] ?? []);
      },
    },
    250,
  );
  expect(failure?.message).toContain("process groups not confirmed stopped by the deadline");
  expect(fake.calls).not.toContain(`kill ${CHILD}`);
  expect(fake.calls).toContain(`cont ${CHILD}`);
});

test("C-LIFE-10 a stopped original with an unheld peer is restored after a failed read", async () => {
  const record = recorded();
  const peer = hook(CHILD + 1, { pgid: CHILD, ppid: 1 });
  const fake = scripted([]);
  let reads = 0;
  const failure = await reapRecordedSurvivors(record, {
    ...fake.ops,
    listProcesses: () => {
      reads += 1;
      if (reads === 1) return Promise.resolve([original]);
      if (reads === 2) return Promise.resolve([{ ...original, stopped: true }, peer]);
      return Promise.reject(errno("EIO"));
    },
  });
  expect(failure).toBeDefined();
  expect(fake.calls).not.toContain(`kill ${CHILD}`);
  expect(fake.calls).toContain(`cont ${CHILD}`);
});

test.each([
  "EPERM",
  "ESRCH",
])("C-LIFE-10 fresh original restoration failure %s never retains a replacement", async (code) => {
  const record = recorded();
  const fake = scripted([]);
  let reads = 0;
  const failure = await reapRecordedSurvivors(record, {
    ...fake.ops,
    listProcesses: () => {
      reads += 1;
      if (reads === 1) return Promise.resolve([original]);
      if (reads === 2) return Promise.resolve([original]);
      return Promise.reject(errno("EIO"));
    },
    continueGroup: () => {
      throw errno(code);
    },
  });
  expect(failure?.processGroupIds).toContain(CHILD);
  expect(record.resumes.pids).toEqual(code === "EPERM" ? [CHILD] : []);
});

test("C-LIFE-10 retry ESRCH clears owned debt without a failure", async () => {
  const record = recorded();
  const stopped = { ...original, stopped: true, shared: true };
  record.resumes.remember([stopped], CHILD);
  const fake = scripted([[stopped]], {
    continueGroup: () => {
      throw errno("ESRCH");
    },
  });
  expect(await reapRecordedSurvivors(record, fake.ops)).toBeUndefined();
  expect(record.resumes.pids).toEqual([]);
});
