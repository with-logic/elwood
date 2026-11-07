/** Identity checks after stopping a survivor group (PRD §5.3, C-LIFE-10). */
import { afterEach, expect, test, vi } from "vitest";
import { DescendantRecord } from "../../src/runtime/shutdown/detached-sweep/record.ts";
import { reapRecordedSurvivors } from "../../src/runtime/shutdown/detached-sweep/survivors.ts";
import { errno, hook, LEADER, leaderRow, scripted } from "../helpers/scripted-process-tree.ts";

const CHILD = 10_000_001;
const original = hook(CHILD, { ppid: 1 });
const replacement = hook(CHILD, { ppid: 1, startedAt: "Sun Oct 25 22:00:09 2026" });
const recorded = () => {
  const record = new DescendantRecord();
  record.observeFirst([leaderRow], LEADER, Date.now());
  record.observe([leaderRow, hook(CHILD)], LEADER);
  return record;
};
afterEach(() => vi.restoreAllMocks());

test("C-LIFE-10 a recycled PGID after SIGSTOP is resumed, never killed", async () => {
  const { ops, calls } = scripted([[original, hook(CHILD + 1, { zombie: true })], [replacement]]);
  const failure = await reapRecordedSurvivors(recorded(), ops);
  expect(calls).not.toContain(`kill ${CHILD}`);
  expect(failure?.message).toContain("survivor group could not be safely confirmed stopped");
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
  expect(record.hasUnknownResume).toBe(true);
});

test("C-LIFE-10 an empty post-stop read cannot authorize retry after a failed restoration", async () => {
  const record = recorded();
  const { ops } = scripted([[original], []], {
    continueGroup: () => {
      throw errno("EPERM");
    },
  });
  await reapRecordedSurvivors(record, ops);
  expect(record.hasUnknownResume).toBe(true);
  const later = scripted([[]]);
  expect((await reapRecordedSurvivors(record, later.ops))?.message).toContain(
    "a stopped group has unresolved restoration",
  );
  expect(later.calls).toEqual(["list"]);
});

test("C-LIFE-10 unresolved restoration is retried independently of survivor ownership", async () => {
  const record = new DescendantRecord();
  record.observeFirst([leaderRow], LEADER, Date.now());
  record.observe([leaderRow], LEADER);
  const stopped = { ...replacement, stopped: true, shared: true };
  record.resumes.remember([stopped], CHILD);
  const refused = scripted([[stopped]], {
    continueGroup: () => {
      throw errno("EPERM");
    },
  });
  expect((await reapRecordedSurvivors(record, refused.ops))?.message).toContain(
    "a stopped group has unresolved restoration",
  );
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
