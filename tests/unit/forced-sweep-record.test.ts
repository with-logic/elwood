/** A failed forced walk retains its observed identities after reparenting (C-LIFE-10). */
import { afterEach, expect, test, vi } from "vitest";
import { sweepDetachedGroups } from "../../src/runtime/shutdown/detached-sweep/index.ts";
import { DescendantRecord } from "../../src/runtime/shutdown/detached-sweep/record.ts";
import { reapRecordedSurvivors } from "../../src/runtime/shutdown/detached-sweep/survivors.ts";
import type { ProcessEntry } from "../../src/runtime/shutdown/process-table.ts";
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
afterEach(() => vi.restoreAllMocks());

test("C-LIFE-10 a failed forced sweep retains every found group member", async () => {
  const record = new DescendantRecord();
  const fake = scripted([]);
  let reads = 0;
  const failure = await sweepDetachedGroups(
    LEADER,
    {
      ...fake.ops,
      listProcesses: () => {
        reads += 1;
        return reads === 1
          ? Promise.resolve(
              fake.asRead([leaderRow, hook(5002), hook(5003, { ppid: 5002, pgid: 5002 })]),
            )
          : Promise.reject(errno("EIO"));
      },
    },
    leaderNeverExits,
    undefined,
    undefined,
    record,
  );
  expect(failure).toBeInstanceOf(Error);
  expect(record.known).toBe(true);
  expect(record.pids).toEqual([5002, 5003]);
  expect(
    record
      .survivors([hook(5002, { ppid: 1 }), hook(5003, { ppid: 5002, pgid: 5002 })])
      .map((row) => row.pid),
  ).toEqual([5002, 5003]);
});

test("C-LIFE-10 a forced walk retains failed shared-daemon restoration debt", async () => {
  const record = new DescendantRecord();
  const child = hook(5002);
  const fake = scripted(
    [
      [leaderRow, child],
      [leaderRow, child],
      [leaderRow, { ...child, shared: true }],
    ],
    {
      continueGroup: () => {
        throw errno("EPERM");
      },
    },
  );
  expect(
    await sweepDetachedGroups(LEADER, fake.ops, leaderNeverExits, undefined, undefined, record),
  ).toBeInstanceOf(Error);
  expect(record.resumes.pids).toEqual([5002]);
  const continued: number[] = [];
  expect(
    record.resumes.retry([{ ...child, stopped: true }], {
      continueGroup: (group) => {
        continued.push(group);
      },
    }),
  ).toBe(true);
  expect(continued).toEqual([5002]);
});

test.each([
  { kind: "leader", leader: leaderRow },
  { kind: "descendant", leader: { ...leaderRow, startedAt: "Sun Oct 25 21:59:00 2026" } },
])("C-LIFE-10 a delayed first walk read preserves initial $kind ambiguity", async ({
  kind,
  leader,
}) => {
  const epoch = Date.parse("2026-10-25T22:00:00.500Z");
  const clock = vi.spyOn(Date, "now").mockReturnValue(epoch);
  const first = Promise.withResolvers<readonly ProcessEntry[]>();
  const child = hook(5002);
  const record = new DescendantRecord();
  let reads = 0;
  const fake = scripted([], {
    listProcesses: () => {
      fake.calls.push("list");
      reads += 1;
      return reads === 1 ? first.promise.then(fake.asRead) : Promise.reject(errno("EIO"));
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
  expect(fake.calls).toEqual([`stop ${LEADER}`, "list"]);
  clock.mockReturnValue(epoch + 5_000);
  first.resolve([leader, child]);
  expect(await pending).toBeDefined();
  expect(record.known).toBe(kind === "descendant");
  expect(record.pids).toEqual(kind === "descendant" ? [child.pid] : []);
  const orphan = { ...child, ppid: 1 };
  if (kind === "descendant")
    expect(record.unsafeSurvivorGroups([orphan])).toEqual(new Set([child.pgid]));
  const retry = scripted([[orphan]]);
  expect(await reapRecordedSurvivors(record, retry.ops)).toBeDefined();
  expect(retry.calls).toEqual(kind === "descendant" ? ["list"] : []);
});
