/**
 * The detached sweep signals a group only while that group's id is still its own (PRD
 * §5.3 and §9.4, C-LIFE-10). A group id read from the table is a snapshot, so a group is
 * stopped only once an EARLIER read showed a parent of one of its members stopped in a
 * group the sweep stopped; after the leader exits, nothing new is signaled. Injected
 * process operations only; no real group is signaled here.
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

describe("C-LIFE-10 detached sweep ownership", () => {
  test("a deeper group waits for a read that shows its parent's group stopped", async () => {
    // 5004 is a setsid child of the hook 5002: it is stopped only after a read taken
    // once 5002's stop landed, so 5002 could not have reaped it and freed its id.
    const tree = [leaderRow, hook(5002), hook(5004, { ppid: 5002 })];
    const { ops, calls } = scripted([tree]);
    await expect(sweepDetachedGroups(LEADER, ops, leaderNeverExits)).resolves.toBeUndefined();
    expect(calls.join(", ")).toBe(
      "stop 5000, list, list, stop 5002, list, list, stop 5004, list, list, kill 5004, kill 5002",
    );
  });

  test("a stop that never shows in a read anchors nothing, up to the deadline", async () => {
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const { ops, calls } = scripted([], {
      listProcesses: () => {
        calls.push("list");
        clock += 400;
        return Promise.resolve([leaderRow, hook(5002)]); // the leader never reads stopped
      },
    });
    const failure = await sweepDetachedGroups(LEADER, ops, leaderNeverExits, 1_000);
    expect(failure).toMatchObject({
      message:
        "Could not reap detached descendants: process groups not confirmed stopped by the deadline",
      processGroupIds: [5002, LEADER],
    });
    expect(calls.join(", ")).toBe("stop 5000, list, list, list");
  });

  test("only the specific parent, held across consecutive reads, anchors a group", async () => {
    // Group 7000 has two members: its head 7000 and 7001, the parent of group 7100. 7001
    // reads running after its group's stop, then stopped, then running again: neither
    // its group's other member nor a stale observation may anchor 7100.
    const head = (stopped: boolean) => hook(7000, { stopped });
    const parent = (stopped: boolean) => hook(7001, { ppid: 7000, pgid: 7000, stopped });
    const child = (stopped = false) => hook(7101, { ppid: 7001, pgid: 7100, stopped });
    const held = { ...leaderRow, stopped: true };
    const reads = [
      [held, head(false), parent(false), child()],
      [held, head(false), parent(false), child()],
      [held, head(true), parent(false), child()], // 7000 stopped; 7001 not yet
      [held, head(true), parent(true), child()], // 7001 stopped for the first time
      [held, head(true), parent(false), child()], // 7001 running again
      [held, head(true), parent(true), child()], // stopped, but the last read had it running
      [held, head(true), parent(true), child()], // held: 7100 is stopped now
      [held, head(true), parent(true), child(true)],
      [held, head(true), parent(true), child(true)],
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
      "stop 5000, list, list, stop 7000, list, list, list, list, list, stop 7100, list, list, kill 7100, kill 7000",
    );
  });

  test("a group under a parent group that refused its stop is never signaled", async () => {
    const tree = [leaderRow, hook(5002), hook(5004, { ppid: 5002 })];
    const { ops, calls } = scripted([tree], {
      stopGroup: (pgid) => {
        calls.push(`stop ${pgid}`);
        if (pgid === 5002) throw errno("EPERM");
      },
    });
    const failure = await sweepDetachedGroups(LEADER, ops, leaderNeverExits);
    expect(failure).toMatchObject({
      message:
        "Could not reap detached descendants: could not stop a live descendant group (EPERM)",
      processGroupIds: [5002],
    });
    expect(calls.join(", ")).toBe("stop 5000, list, list, stop 5002, list");
  });

  test("when the leader's group cannot be stopped, no descendant group is signaled", async () => {
    for (const thrown of [errno("EPERM"), undefined]) {
      const { ops, calls } = scripted([[leaderRow, hook(5002)]], {
        stopGroup: (pgid) => {
          calls.push(`stop ${pgid}`);
          throw thrown;
        },
      });
      const failure = await sweepDetachedGroups(LEADER, ops, leaderNeverExits);
      const token = thrown === undefined ? "" : " (EPERM)";
      expect(failure).toMatchObject({
        message: `Could not reap detached descendants: could not stop the leader's group${token}`,
        processGroupIds: [5002],
      });
      expect(calls.join(", ")).toBe("stop 5000, list");
    }
  });

  test("an unstoppable leader's group is no failure when nothing left it", async () => {
    const { ops, calls } = scripted([[leaderRow]], {
      stopGroup: () => {
        throw errno("ESRCH");
      },
    });
    await expect(sweepDetachedGroups(LEADER, ops, leaderNeverExits)).resolves.toBeUndefined();
    expect(calls).toEqual(["list"]);
  });

  test("an exit during a read stops all new signals and fails if a group was unreached", async () => {
    let exited = false;
    const { ops, calls, asRead } = scripted([], {
      listProcesses: () => {
        calls.push("list");
        const listings = calls.filter((call) => call === "list").length;
        if (listings === 3) exited = true; // the leader exits while `ps` runs
        const late = listings === 3 ? [hook(5004)] : [];
        return Promise.resolve(asRead([leaderRow, hook(5002), ...late]));
      },
    });
    const failure = await sweepDetachedGroups(LEADER, ops, () => exited);
    expect(failure).toMatchObject({
      message:
        "Could not reap detached descendants: the leader exited before every descendant group was stopped",
      processGroupIds: [5004],
    });
    expect(calls.join(", ")).toBe("stop 5000, list, list, stop 5002, list, kill 5002");
  });

  test("an exit during a read that leaves nothing unreached is a clean sweep", async () => {
    let exited = false;
    const { ops, calls } = scripted([], {
      listProcesses: () => {
        calls.push("list");
        exited = true;
        return Promise.resolve([leaderRow]);
      },
    });
    await expect(sweepDetachedGroups(LEADER, ops, () => exited)).resolves.toBeUndefined();
    expect(calls).toEqual([`stop ${LEADER}`, "list"]);
  });
});
