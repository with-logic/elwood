/**
 * The detached sweep's second SIGSTOP for a stopped group that still has a running member
 * (PRD §5.3 and §9.4, C-LIFE-10): `killpg` signals the members it finds, so a child forked
 * while it runs can miss the stop, as one did in a real Claude teardown's login shell.
 * Injected process operations only — no real group is signaled here.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  type SweepOps,
  sweepDetachedGroups,
} from "../../src/runtime/shutdown/detached-sweep/index.ts";
import {
  errno,
  hook,
  LEADER,
  leaderNeverExits,
  leaderRow,
  scripted,
} from "../helpers/scripted-process-tree.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

/** A member of the leader's own group, as the login shell's pipeline children are. */
const shellChild = hook(5001, { pgid: LEADER });
/** A member of hook 5002's group that its stop missed. */
const hookChild = hook(5003, { ppid: 5002, pgid: 5002 });

/** `ops` under a fake clock each listing advances, so a sweep that never settles meets its deadline. */
function ticking(ops: SweepOps): SweepOps {
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  return {
    ...ops,
    listProcesses: (timeoutMs) => {
      clock += 100;
      return ops.listProcesses(timeoutMs);
    },
  };
}

/** A stop that logs each call; a group's first stop lands and every later one is refused with `code`. */
function refuseRestops(code: string, log: (line: string) => void): (pgid: number) => void {
  const sent = new Set<number>();
  return (pgid) => {
    log(`stop ${pgid}`);
    if (sent.has(pgid)) throw errno(code);
    sent.add(pgid);
  };
}

describe("C-LIFE-10 detached sweep re-stops a group member its first stop missed", () => {
  test("stops the leader's group again for a child forked during its stop", async () => {
    const { ops, calls } = scripted([[leaderRow, shellChild]], {}, new Set([5001]));
    await expect(
      sweepDetachedGroups(LEADER, ticking(ops), leaderNeverExits),
    ).resolves.toBeUndefined();
    expect(calls.join(", ")).toBe("stop 5000, list, stop 5000, list, list");
  });

  test("stops a hook's group again for a child forked during its stop, then kills it", async () => {
    const before = [leaderRow, hook(5002)];
    const after = [...before, hookChild];
    const { ops, calls } = scripted([before, before, after], {}, new Set([5003]));
    await expect(
      sweepDetachedGroups(LEADER, ticking(ops), leaderNeverExits),
    ).resolves.toBeUndefined();
    expect(calls.join(", ")).toBe(
      "stop 5000, list, list, stop 5002, list, stop 5002, list, list, kill 5002",
    );
  });

  test("a re-stop that finds the group gone is not a failure; the next read decides", async () => {
    const run = scripted(
      [[leaderRow, shellChild], []],
      { stopGroup: refuseRestops("ESRCH", (line) => run.calls.push(line)) },
      new Set([5001]),
    );
    await expect(sweepDetachedGroups(LEADER, run.ops, leaderNeverExits)).resolves.toBeUndefined();
    expect(run.calls.join(", ")).toBe("stop 5000, list, stop 5000, list");
  });

  test.each([
    {
      group: LEADER,
      tables: [[leaderRow, shellChild]],
      escaped: 5001,
      reason: "could not stop the leader's group (EPERM)",
    },
    {
      group: 5002,
      tables: [
        [leaderRow, hook(5002)],
        [leaderRow, hook(5002)],
        [leaderRow, hook(5002), hookChild],
      ],
      escaped: 5003,
      reason: "could not stop a live descendant group (EPERM)",
    },
  ])("a refused re-stop of group $group names it with its errno", async (row) => {
    const run = scripted(
      row.tables,
      { stopGroup: refuseRestops("EPERM", (line) => run.calls.push(line)) },
      new Set([row.escaped]),
    );
    const failure = await sweepDetachedGroups(LEADER, ticking(run.ops), leaderNeverExits, 1_000);
    expect(failure?.message).toContain(row.reason);
    expect(failure?.message).toContain("process groups not confirmed stopped by the deadline");
    expect(failure).toMatchObject({ code: "EPERM", processGroupIds: [row.group] });
    expect(run.calls.filter((call) => call === `stop ${row.group}`).length).toBeGreaterThan(2);
  });
});
