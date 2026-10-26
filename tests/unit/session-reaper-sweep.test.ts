/**
 * `SessionReaper`'s handle on the detached sweep (PRD §5.3 and §9.4, C-LIFE-10): it
 * sweeps through the session's ops, refuses misrouted leader ids, and keeps a failed
 * sweep so every later confirmed reap still fails after reaping the leader's group.
 * Injected process operations only; no real group is signaled here.
 */

import { describe, expect, test } from "vitest";
import { SessionReaper } from "../../src/runtime/shutdown/reap-tree.ts";
import {
  errno,
  hook,
  LEADER,
  leaderNeverExits,
  leaderRow,
  scripted,
} from "../helpers/scripted-process-tree.ts";

describe("C-LIFE-10 SessionReaper detached sweep", () => {
  test("sweeps through its injected ops and refuses misrouted leader ids", async () => {
    const swept = scripted([[leaderRow, hook(5002)], [leaderRow, hook(5002)], [leaderRow]]);
    await new SessionReaper(LEADER, swept.ops).sweepDetached(leaderNeverExits);
    expect(swept.calls).toContain("kill 5002");
    for (const pid of [0, 1, process.pid]) {
      const refused = scripted([[leaderRow]]);
      await new SessionReaper(pid, refused.ops).sweepDetached(leaderNeverExits);
      expect(refused.calls).toEqual([]);
    }
  });

  test("keeps a failed sweep: each confirmed reap reaps the group, then fails", async () => {
    const { ops, calls } = scripted([], { listProcesses: () => Promise.reject(errno("EAGAIN")) });
    const reaper = new SessionReaper(LEADER, ops);
    await expect(reaper.sweepDetached(leaderNeverExits)).rejects.toMatchObject({ code: "EAGAIN" });
    const unreadable = "process table unreadable (EAGAIN)";
    expect(() => reaper.reapAndThrowOnDetachedSweepFailure()).toThrow(unreadable);
    expect(calls).toEqual([`stop ${LEADER}`, `kill ${LEADER}`]); // reaped before it threw
    expect(() => reaper.reapAndThrowOnDetachedSweepFailure()).toThrow(unreadable);
    expect(() => reaper.reap()).not.toThrow();
    expect(calls).toEqual([`stop ${LEADER}`, `kill ${LEADER}`]); // latched: reaped once
  });

  test("keeps a leader exit that left a found group unreached as a failure", async () => {
    let exited = false;
    const { ops, asRead } = scripted([], {
      listProcesses: () => {
        exited = true; // the leader exits while `ps` runs, with a hook still unreached
        return Promise.resolve(asRead([leaderRow, hook(5002)]));
      },
    });
    const reaper = new SessionReaper(LEADER, ops);
    const unreached = "the leader exited before every group was confirmed stopped";
    await expect(reaper.sweepDetached(() => exited)).rejects.toMatchObject({
      processGroupIds: [5002, LEADER], // the hook unreached, the leader's group not yet held
    });
    expect(() => reaper.reapAndThrowOnDetachedSweepFailure()).toThrow(unreached);
  });
});
