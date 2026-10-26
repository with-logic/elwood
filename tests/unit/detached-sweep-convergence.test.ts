/**
 * The detached sweep succeeds only on a read that converges (PRD §5.3 and §9.4,
 * C-LIFE-10): one that shows the leader live, leaves no live group unreached, and holds
 * every live member of every group it signaled. A leader exit observed first fails the
 * sweep, because a detached descendant the leader left is out of reach. Injected process
 * operations only; no real group is signaled here.
 */

import { describe, expect, test } from "vitest";
import {
  type SweepOps,
  sweepDetachedGroups,
} from "../../src/runtime/shutdown/detached-sweep/index.ts";
import type { ProcessEntry } from "../../src/runtime/shutdown/process-table.ts";
import { hook, LEADER, leaderRow, scripted } from "../helpers/scripted-process-tree.ts";

const EXITED =
  "Could not reap detached descendants: the leader exited before every group was confirmed stopped";

/**
 * `ops` whose listing number `at` is the one during which the leader exits, so the
 * `leaderExited` read after it reports the exit.
 */
function exitDuring(ops: SweepOps, at: number): { ops: SweepOps; exited: () => boolean } {
  let listings = 0;
  return {
    ops: {
      ...ops,
      listProcesses: (timeoutMs) => {
        listings += 1;
        return ops.listProcesses(timeoutMs);
      },
    },
    exited: () => listings >= at,
  };
}

const stoppedLeader: ProcessEntry = { ...leaderRow, stopped: true };

describe("C-LIFE-10 detached sweep convergence", () => {
  test("an exit before the first read, with the leader's hook already under PID 1, fails", async () => {
    // Nothing is left to find, but nothing was held either: the hook is out of reach.
    const run = scripted([[hook(5002, { ppid: 1 })]]);
    const { ops, exited } = exitDuring(run.ops, 1);
    await expect(sweepDetachedGroups(LEADER, ops, exited)).resolves.toMatchObject({
      message: EXITED,
      processGroupIds: [LEADER],
    });
    expect(run.calls.join(", ")).toBe("stop 5000, list");
  });

  test("an exit seen on the read that first shows the leader stopped fails", async () => {
    const run = scripted([[stoppedLeader]]);
    const { ops, exited } = exitDuring(run.ops, 1);
    await expect(sweepDetachedGroups(LEADER, ops, exited)).resolves.toMatchObject({
      message: EXITED,
      processGroupIds: [LEADER],
    });
    expect(run.calls.join(", ")).toBe("stop 5000, list");
  });

  test("an exit while a signaled group has a member not yet held fails; that group is still killed", async () => {
    // 5003 was forked as 5002's stop went out, so the read that sees the exit shows it running.
    const before = [leaderRow, hook(5002)];
    const after = [...before, hook(5003, { ppid: 5002, pgid: 5002 })];
    const run = scripted([before, before, after], {}, new Set([5003]));
    const { ops, exited } = exitDuring(run.ops, 3);
    await expect(sweepDetachedGroups(LEADER, ops, exited)).resolves.toMatchObject({
      message: EXITED,
      processGroupIds: [5002],
    });
    expect(run.calls.join(", ")).toBe("stop 5000, list, list, stop 5002, list, kill 5002");
  });

  test("reads that no longer show the leader keep the walk open until its exit is observed", async () => {
    const run = scripted([[leaderRow], [], []]);
    const { ops, exited } = exitDuring(run.ops, 3);
    await expect(sweepDetachedGroups(LEADER, ops, exited)).resolves.toMatchObject({
      message: EXITED,
      processGroupIds: [LEADER],
    });
    expect(run.calls.join(", ")).toBe("stop 5000, list, list, list");
  });

  test("a read that converges returns before the exit check, so an exit during it is clean", async () => {
    const run = scripted([[leaderRow]]);
    const { ops, exited } = exitDuring(run.ops, 2);
    await expect(sweepDetachedGroups(LEADER, ops, exited)).resolves.toBeUndefined();
    expect(run.calls.join(", ")).toBe("stop 5000, list, list");
  });
});
