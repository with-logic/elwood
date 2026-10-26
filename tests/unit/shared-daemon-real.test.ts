/**
 * Real-process proof that the detached walk never kills Codex's shared app-server daemon
 * when the walk stops the process just as it becomes the daemon (PRD §5.3 and §9.4,
 * C-LIFE-10). The TUI forks the daemon as a `codex` group leader of its own and then
 * `exec`s the daemon, so a path read between the two finds no daemon, and the walk can
 * stop its group after the `exec`, then the leader can exit, leaving the daemon under PID 1.
 * Node cannot `exec`, so the fixture's process stands in by taking the daemon's path as
 * its title, which macOS `ps` reads as its `comm`.
 */

import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { sweepDetachedGroups } from "../../src/runtime/shutdown/detached-sweep/index.ts";
import { osProcessTreeOps, SessionReaper } from "../../src/runtime/shutdown/reap-tree.ts";
import {
  type DetachedTree,
  detachedDescendantPids,
  startDetachedTree,
  waitForTreeProcessPid,
} from "../helpers/detached-tree.ts";
import { pollGone, processRows } from "../helpers/process-liveness.ts";

const DAEMON_DIR = "/packages/app-server-daemon/";

/** Blocks this thread until `done`, as a SIGSTOP the walk sends must wait on the `exec`. */
function waitSync(done: () => boolean, failure: string): void {
  const deadline = performance.now() + 5_000;
  while (!done()) {
    if (performance.now() > deadline) throw new Error(failure);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
  }
}

/** Has the tree's `becoming` process take the daemon's path, and waits until it has. */
function becomeDaemon(tree: DetachedTree): void {
  writeFileSync(join(tree.dir, "exec"), "");
  waitSync(() => existsSync(join(tree.dir, "became")), "the process never became the daemon");
}

/** The parent pid `ps` reads for `pid`. */
function parentOf(pid: number): number {
  return Number(execFileSync("/bin/ps", ["-o", "ppid=", "-p", String(pid)]).toString());
}

describe("C-LIFE-10 Codex's daemon, stopped as it starts (real processes)", () => {
  test.skipIf(process.platform !== "darwin")(
    "a group stopped as its process became the daemon is resumed, not killed",
    async () => {
      const tree = startDetachedTree("becomes-daemon");
      const [child, grandchild] = await detachedDescendantPids(tree);
      const becoming = await waitForTreeProcessPid(tree, "becoming");
      const command = () => processRows(10_000).find((row) => row.pid === becoming)?.command;
      expect(command()).not.toContain(DAEMON_DIR);
      // It becomes the daemon after the walk read its path, before the walk's SIGSTOP.
      const stopGroup = (pgid: number) => {
        if (pgid === becoming) becomeDaemon(tree);
        osProcessTreeOps.stopGroup(pgid);
      };
      const reaper = new SessionReaper(tree.pty.pid, { ...osProcessTreeOps, stopGroup });
      await reaper.sweepDetached(() => false);
      reaper.reap();
      expect(await pollGone({ pid: child, timeoutMs: 5_000 })).toBe(true);
      expect(await pollGone({ pid: grandchild, timeoutMs: 5_000 })).toBe(true);
      // Running again, and still this tree's process, not a reuse of its pid.
      expect(processRows(10_000).find((entry) => entry.pid === becoming)).toMatchObject({
        command: expect.stringContaining(`${tree.dir}${DAEMON_DIR}`),
        stat: expect.stringMatching(/^[^TZ]/),
      });
    },
  );

  test.skipIf(process.platform !== "darwin")(
    "one stopped as it became the daemon is resumed after the leader's exit left it under PID 1",
    async () => {
      const tree = startDetachedTree("becomes-daemon");
      const [child] = await detachedDescendantPids(tree);
      const becoming = await waitForTreeProcessPid(tree, "becoming");
      let leaderKilled = false;
      // The sequence: the walk stops the group of the process about to become the daemon,
      // which then takes the daemon's path. Before the walk's next read, something else
      // SIGKILLs the PTY leader, as one can, and the leader's exit leaves that stopped
      // group under PID 1, outside the leader's tree. The walk must still resume it.
      const stopGroup = (pgid: number) => {
        if (pgid === becoming) becomeDaemon(tree);
        osProcessTreeOps.stopGroup(pgid);
        if (pgid !== becoming) return;
        // The leader is this test's own child, so its pid is still its own until reaped.
        process.kill(tree.pty.pid, "SIGKILL");
        leaderKilled = true;
        waitSync(() => parentOf(becoming) === 1, "the leader's exit never reparented it");
      };
      // A budget a loaded host cannot run out before the read after the leader's exit.
      const ops = { ...osProcessTreeOps, stopGroup };
      const failure = await sweepDetachedGroups(tree.pty.pid, ops, () => leaderKilled, 20_000);
      expect(failure?.message).toMatch(/the leader exited before every group/);
      expect(await pollGone({ pid: child, timeoutMs: 5_000 })).toBe(true);
      expect(processRows(10_000).find((entry) => entry.pid === becoming)).toMatchObject({
        ppid: 1,
        command: expect.stringContaining(`${tree.dir}${DAEMON_DIR}`),
        stat: expect.stringMatching(/^[^TZ]/),
      });
    },
  );
});
