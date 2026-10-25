/**
 * The stop-list-kill sweep of a live leader's detached descendant groups.
 * Covers PRD §5.3 and §9.4 (C-LIFE-10) with injected process operations only —
 * no real group is signaled here.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { sweepDetachedGroups } from "../../src/runtime/shutdown/detached-sweep/index.ts";
import {
  alive,
  errno,
  hook,
  LEADER,
  leaderRow,
  scripted,
} from "../helpers/scripted-process-tree.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

const kills = (calls: readonly string[]) => calls.filter((call) => call.startsWith("kill"));

describe("C-LIFE-10 detached descendant sweep", () => {
  test("stops the leader first and lists once when nothing left the group", async () => {
    const { ops, calls } = scripted([[leaderRow]]);
    await expect(sweepDetachedGroups(LEADER, ops, alive)).resolves.toBeUndefined();
    expect(calls).toEqual([`stop ${LEADER}`, "list"]);
  });

  test("stops groups once a read confirmed their parent stopped, then kills deepest first", async () => {
    // The first read shows the leader stopped; groups under it are stopped after the
    // second, and a read that leaves nothing unreached ends the walk.
    const { ops, calls } = scripted([
      [leaderRow, hook(5002), hook(5003)],
      [leaderRow, hook(5002), hook(5003), hook(5004)],
    ]);
    await expect(sweepDetachedGroups(LEADER, ops, alive)).resolves.toBeUndefined();
    expect(calls.join(", ")).toBe(
      "stop 5000, list, list, stop 5002, stop 5003, stop 5004, list, kill 5004, kill 5003, kill 5002",
    );
  });

  test("the deadline, shared by every listing, governs a tree that never settles", async () => {
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    let found = 0;
    const { ops, calls, timeouts, asRead } = scripted([], {
      listProcesses: (timeoutMs) => {
        timeouts.push(timeoutMs);
        calls.push("list");
        clock += 400;
        found += 1;
        const hooks = Array.from({ length: found }, (_, index) => hook(6000 + index));
        return Promise.resolve(asRead([leaderRow, ...hooks]));
      },
    });
    const failure = await sweepDetachedGroups(LEADER, ops, alive, 1_000);
    expect(failure?.message).toBe(
      "Could not reap detached descendants: descendant groups still appearing at the deadline",
    );
    expect(timeouts).toEqual([1_000, 600, 200]);
    expect(calls.join(", ")).toBe(
      "stop 5000, list, list, stop 6000, stop 6001, list, stop 6002, kill 6002, kill 6001, kill 6000",
    );
  });

  test("a failed listing still kills what was stopped and reports only a bounded reason", async () => {
    const { ops, calls, asRead } = scripted([], {
      listProcesses: () => {
        calls.push("list");
        return calls.filter((call) => call === "list").length > 2
          ? Promise.reject(errno("ETIMEDOUT"))
          : Promise.resolve(asRead([leaderRow, hook(5002)]));
      },
    });
    const failure = await sweepDetachedGroups(LEADER, ops, alive);
    expect(failure).toMatchObject({
      message: "Could not reap detached descendants: process table unreadable (ETIMEDOUT)",
      code: "ETIMEDOUT",
    });
    expect(calls.join(", ")).toBe("stop 5000, list, list, stop 5002, list, kill 5002");
  });

  test("a group gone before its stop, or left with only zombies, needs nothing", async () => {
    const { ops, calls } = scripted(
      [
        [leaderRow, hook(5002), hook(5003)],
        [leaderRow, hook(5002), hook(5003)],
        [leaderRow, hook(5003, { zombie: true })],
      ],
      {
        stopGroup: (pgid) => {
          if (pgid === 5002) throw errno("ESRCH");
          if (pgid === 5003) throw errno("EPERM"); // macOS: every member is an unreaped zombie
        },
      },
    );
    await expect(sweepDetachedGroups(LEADER, ops, alive)).resolves.toBeUndefined();
    expect(kills(calls)).toEqual([]);
  });

  test("a live group that refuses the stop is never killed and fails the sweep", async () => {
    const stops: number[] = [];
    const { ops, calls } = scripted([[leaderRow, hook(5002)]], {
      stopGroup: (pgid) => {
        stops.push(pgid);
        if (pgid === 5002) throw errno("EPERM");
      },
    });
    const failure = await sweepDetachedGroups(LEADER, ops, alive);
    expect(failure).toMatchObject({
      message:
        "Could not reap detached descendants: could not stop a live descendant group (EPERM)",
      code: "EPERM",
      groups: [5002],
    });
    expect(stops).toEqual([LEADER, 5002]); // not retried every round
    expect(kills(calls)).toEqual([]);
  });

  test("a failed kill does not stop the rest; each reason is reported once", async () => {
    const attempts: number[] = [];
    const tables = [[leaderRow, hook(5002), hook(5003), hook(5004)], [leaderRow]];
    const { ops } = scripted([tables[0] ?? [], tables[0] ?? [], tables[1] ?? []], {
      killGroup: (pgid) => {
        attempts.push(pgid);
        if (pgid !== 5002) throw Object.assign(new Error("kill exploded"), { code: "not errno" });
      },
    });
    const failure = await sweepDetachedGroups(LEADER, ops, alive);
    expect(attempts).toEqual([5004, 5003, 5002]); // the last succeeds after two failed
    expect(failure?.message).toBe(
      "Could not reap detached descendants: could not kill a stopped descendant group",
    );
    expect(failure).toMatchObject({ groups: [5004, 5003] });
    expect(failure).not.toHaveProperty("code");
  });

  test("an exit observed before the sweep sends nothing", async () => {
    const { ops, calls } = scripted([[leaderRow, hook(5002)]]);
    await expect(sweepDetachedGroups(LEADER, ops, () => true)).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });
});
