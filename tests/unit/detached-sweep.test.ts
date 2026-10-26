/**
 * The stop-list-kill sweep of a live leader's detached descendant groups.
 * Covers PRD §5.3 and §9.4 (C-LIFE-10) with injected process operations only —
 * no real group is signaled here.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { sweepDetachedGroups } from "../../src/runtime/shutdown/detached-sweep/index.ts";
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

const kills = (calls: readonly string[]) => calls.filter((call) => call.startsWith("kill"));

describe("C-LIFE-10 detached descendant sweep", () => {
  test("stops the leader first and ends once a second read still shows it stopped", async () => {
    const { ops, calls } = scripted([[leaderRow]]);
    await expect(sweepDetachedGroups(LEADER, ops, leaderNeverExits)).resolves.toBeUndefined();
    expect(calls).toEqual([`stop ${LEADER}`, "list", "list"]);
  });

  test("a leader whose stop has not landed yet is read again, so its late hook is found", async () => {
    // kill() returned, but the first read still shows the leader running and nothing
    // detached, so it is stopped again: it starts a hook before the stop lands, which a
    // second read shows.
    const stopped = { ...leaderRow, stopped: true };
    const reads = [
      [leaderRow],
      [stopped, hook(5002)],
      [stopped, hook(5002)],
      [stopped, hook(5002, { stopped: true })],
    ];
    const { ops, calls } = scripted([], {
      listProcesses: () => {
        calls.push("list");
        const listing = calls.filter((call) => call === "list").length;
        return Promise.resolve(reads[Math.min(listing, reads.length) - 1] ?? []);
      },
    });
    await expect(sweepDetachedGroups(LEADER, ops, leaderNeverExits)).resolves.toBeUndefined();
    expect(calls.join(", ")).toBe(
      "stop 5000, list, stop 5000, list, list, stop 5002, list, list, kill 5002",
    );
  });

  test("stops groups once a read confirmed their parent stopped, then kills deepest first", async () => {
    // The first read shows the leader stopped and the second still does, so the groups
    // under it are stopped; two more reads hold them, with nothing left unreached.
    const { ops, calls } = scripted([
      [leaderRow, hook(5002), hook(5003)],
      [leaderRow, hook(5002), hook(5003), hook(5004)],
    ]);
    await expect(sweepDetachedGroups(LEADER, ops, leaderNeverExits)).resolves.toBeUndefined();
    expect(calls.join(", ")).toBe(
      "stop 5000, list, list, stop 5002, stop 5003, stop 5004, list, list, kill 5004, kill 5003, kill 5002",
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
    const failure = await sweepDetachedGroups(LEADER, ops, leaderNeverExits, 1_000);
    expect(failure).toMatchObject({
      message:
        "Could not reap detached descendants: process groups not confirmed stopped by the deadline",
      processGroupIds: [6000, 6001, 6002],
    });
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
    const failure = await sweepDetachedGroups(LEADER, ops, leaderNeverExits);
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
    await expect(sweepDetachedGroups(LEADER, ops, leaderNeverExits)).resolves.toBeUndefined();
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
    const failure = await sweepDetachedGroups(LEADER, ops, leaderNeverExits);
    expect(failure).toMatchObject({
      message:
        "Could not reap detached descendants: could not stop a live descendant group (EPERM)",
      code: "EPERM",
      processGroupIds: [5002],
    });
    expect(stops).toEqual([LEADER, 5002]); // not retried every round
    expect(kills(calls)).toEqual([]);
  });

  test("an exit observed before the sweep sends nothing", async () => {
    const { ops, calls } = scripted([[leaderRow, hook(5002)]]);
    await expect(sweepDetachedGroups(LEADER, ops, () => true)).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });
});
