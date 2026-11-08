/** Per-session detached sweeps never overlap their signal passes (PRD §9.4, C-LIFE-10). */
import { setImmediate } from "node:timers/promises";
import { expect, test } from "vitest";
import { SessionReaper } from "../../src/runtime/shutdown/reap-tree.ts";
import {
  errno,
  LEADER,
  leaderNeverExits,
  leaderRow,
  scripted,
  useScriptedHost,
} from "../helpers/scripted-process-tree.ts";

useScriptedHost();

test("C-LIFE-10 overlapping detached sweeps start immediately only when idle", async () => {
  const firstRead = Promise.withResolvers<void>();
  let reads = 0;
  const { ops, calls, asRead } = scripted([], {
    listProcesses: async () => {
      reads += 1;
      if (reads === 1) await firstRead.promise;
      return asRead([leaderRow]);
    },
  });
  const reaper = new SessionReaper(LEADER, ops);
  const first = reaper.sweepDetached(leaderNeverExits);
  expect(reads).toBe(1);
  const second = reaper.sweepDetached(leaderNeverExits);
  await setImmediate();
  expect(calls).toEqual([`stop ${LEADER}`]);
  expect(reads).toBe(1);
  firstRead.resolve();
  await Promise.all([first, second]);
  expect(calls).toEqual([`stop ${LEADER}`, `stop ${LEADER}`]);
  expect(reads).toBe(4);
});

test("C-LIFE-10 a failed queued sweep rejects and stays unresolved", async () => {
  const firstRead = Promise.withResolvers<void>();
  let reads = 0;
  const { ops, asRead } = scripted([], {
    listProcesses: async () => {
      reads += 1;
      if (reads === 1) await firstRead.promise;
      if (reads > 2) throw errno("EAGAIN");
      return asRead([leaderRow]);
    },
  });
  const reaper = new SessionReaper(LEADER, ops);
  const first = reaper.sweepDetached(leaderNeverExits);
  const failed = expect(reaper.sweepDetached(leaderNeverExits)).rejects.toMatchObject({
    code: "EAGAIN",
  });
  firstRead.resolve();
  await first;
  await failed;
  expect(() => reaper.reapOrConfirmAndThrowIfUnresolved()).toThrow("process table unreadable");
});
