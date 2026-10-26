/**
 * The kill pass never kills Codex's shared daemon (PRD §5.3 and §9.4, C-LIFE-10). The
 * TUI forks the daemon as a `codex` group leader and then `exec`s it, so a group the walk
 * stopped can turn out to hold the daemon. The latest read decides: a group it shows
 * holding the daemon, or a process not stopped that could still become it, is resumed
 * (SIGCONT), not killed. Scripted tables; `shared-daemon-real.test.ts` has the real one.
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
    const refusing = (code: string) => ({
      ...scripted(tables).ops,
      continueGroup: () => {
        throw errno(code);
      },
    });
    const gone = sweepDetachedGroups(LEADER, refusing("ESRCH"), leaderNeverExits);
    await expect(gone).resolves.toBeUndefined();
    expect(await sweepDetachedGroups(LEADER, refusing("EPERM"), leaderNeverExits)).toMatchObject({
      message:
        "Could not reap detached descendants: could not resume a group spared as Codex's daemon (EPERM)",
      processGroupIds: [5010],
      code: "EPERM",
    });
  });
});
