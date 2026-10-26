/**
 * The kill pass never kills Codex's shared daemon (PRD §5.3 and §9.4, C-LIFE-10). The
 * TUI forks the daemon as a `codex` group leader and then `exec`s it, so a group the walk
 * stopped can turn out to hold the daemon. The latest read decides: a group it shows
 * holding the daemon, or a process not stopped that could still become it, is resumed
 * (SIGCONT), not killed. Scripted tables; `shared-daemon-real.test.ts` has the real one.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { sweepDetachedGroups } from "../../src/runtime/shutdown/detached-sweep/index.ts";
import { DescendantRecord } from "../../src/runtime/shutdown/detached-sweep/record.ts";
import { reapRecordedSurvivors } from "../../src/runtime/shutdown/detached-sweep/survivors.ts";
import type { DaemonScope } from "../../src/runtime/shutdown/shared-daemon.ts";
import {
  errno,
  hook,
  LEADER,
  leaderNeverExits,
  leaderRow,
  scripted,
  ticking,
} from "../helpers/scripted-process-tree.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

// 5010 has the daemon's shape: a `codex` group leader the TUI started. Its path is read
// as the TUI's until it `exec`s the daemon, after the walk stopped its group.
const forked = hook(5010, { name: "codex" });
const execd = hook(5010, { name: "codex", shared: true });
const tables = [
  [leaderRow, forked],
  [leaderRow, forked],
  [leaderRow, execd],
];

describe("C-LIFE-10 the kill pass and Codex's shared daemon", () => {
  test("a group the latest read shows holding the daemon is resumed, not killed", async () => {
    const { ops, calls } = scripted(tables);
    await expect(sweepDetachedGroups(LEADER, ops, leaderNeverExits)).resolves.toBeUndefined();
    expect(calls.join(", ")).toBe("stop 5000, list, list, stop 5010, list, list, cont 5010");
  });

  test("a stopped group with the daemon's shape that no read marks is killed, not resumed", async () => {
    // Stopped, it cannot `exec` the daemon any more, and its path was read as not one.
    const { ops, calls } = scripted([[leaderRow, forked]]);
    await expect(sweepDetachedGroups(LEADER, ops, leaderNeverExits)).resolves.toBeUndefined();
    expect(calls.join(", ")).toBe("stop 5000, list, list, stop 5010, list, list, kill 5010");
  });

  test("a process that could be the daemon, not shown stopped, is resumed; a hook is killed", async () => {
    // The deadline ends the walk on the read before the one that would show them stopped.
    const { ops, calls } = scripted([[leaderRow, hook(5002), forked]]);
    const failure = await sweepDetachedGroups(LEADER, ticking(ops), leaderNeverExits, 200);
    expect(failure?.message).toBe(
      "Could not reap detached descendants: process groups not confirmed stopped by the deadline",
    );
    expect(calls.slice(-2)).toEqual(["cont 5010", "kill 5002"]);
    expect(calls).not.toContain("kill 5010"); // Never killed, then resumed.
  });

  test("a resumed group already gone needs nothing; any other refusal fails the sweep", async () => {
    // A hook (5002) stopped before the daemon's group, so the kill pass reaches it after
    // the resume: a refused resume is seen not to end the pass.
    const withHook = tables.map(([leader = leaderRow, daemon = forked]) => [
      leader,
      hook(5002),
      daemon,
    ]);
    const refusing = (code: string) => {
      const { ops, calls } = scripted(withHook);
      const continueGroup = (pgid: number) => {
        ops.continueGroup(pgid);
        throw errno(code);
      };
      return { ops: { ...ops, continueGroup }, calls };
    };
    const gone = refusing("ESRCH");
    await expect(sweepDetachedGroups(LEADER, gone.ops, leaderNeverExits)).resolves.toBeUndefined();
    expect(gone.calls.slice(-2)).toEqual(["cont 5010", "kill 5002"]);
    expect(gone.calls).not.toContain("kill 5010"); // Gone is not a reason to kill its id.
    const refused = refusing("EPERM");
    expect(await sweepDetachedGroups(LEADER, refused.ops, leaderNeverExits)).toMatchObject({
      message:
        "Could not reap detached descendants: could not resume a group spared for Codex's shared daemon (EPERM)",
      processGroupIds: [5010],
      code: "EPERM",
    });
    expect(refused.calls.slice(-2)).toEqual(["cont 5010", "kill 5002"]);
    expect(refused.calls).not.toContain("kill 5010");
  });

  test("the reap of a stop's survivors resumes a group that became the daemon too", async () => {
    // Recorded as the TUI's fork; once the TUI exits it hangs off PID 1, then `exec`s.
    const record = new DescendantRecord();
    record.observe([leaderRow, forked], LEADER);
    const orphan = { ...forked, ppid: 1 };
    const { ops, calls } = scripted([[orphan], [{ ...orphan, shared: true }]]);
    await expect(reapRecordedSurvivors(record, ops)).resolves.toBeUndefined();
    expect(calls.join(", ")).toBe("list, stop 5010, list, list, cont 5010");
  });

  test("the reap of a stop's survivors reads each group it stopped, wherever its parent is", async () => {
    // 5010, which a recorded hook started after the last recording read, is no recorded pid.
    const record = new DescendantRecord();
    record.observe([leaderRow, hook(5002)], LEADER);
    const { ops } = scripted([[hook(5002, { ppid: 1 }), hook(5010, { ppid: 5002 })]]);
    const roots: number[][] = [];
    const listProcesses = (timeoutMs: number, scope?: DaemonScope) => {
      roots.push([...(scope?.roots ?? [])]);
      return ops.listProcesses(timeoutMs);
    };
    await expect(reapRecordedSurvivors(record, { ...ops, listProcesses })).resolves.toBeUndefined();
    expect([roots[0], roots.at(-1)]).toEqual([[5002], [5002, 5010]]);
  });
});
