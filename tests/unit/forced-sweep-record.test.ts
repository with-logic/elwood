/** A failed forced walk retains its observed identities after reparenting (C-LIFE-10). */
import { expect, test } from "vitest";
import { sweepDetachedGroups } from "../../src/runtime/shutdown/detached-sweep/index.ts";
import { DescendantRecord } from "../../src/runtime/shutdown/detached-sweep/record.ts";
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
