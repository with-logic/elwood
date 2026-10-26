/**
 * Real-process proof that the detached walk never kills Codex's shared app-server daemon
 * when the walk stops the process just as it becomes the daemon (PRD §5.3 and §9.4,
 * C-LIFE-10). The TUI forks the daemon as a `codex` group leader of its own and then
 * `exec`s the daemon, so a path read between the two finds no daemon, and the walk can
 * stop its group after the `exec`. Node cannot `exec`, so the fixture's process stands in
 * by taking the daemon's path as its title, which macOS `ps` reads as its `comm`.
 */

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { osProcessTreeOps, SessionReaper } from "../../src/runtime/shutdown/reap-tree.ts";
import { detachedDescendantPids, extraPid, startDetachedTree } from "../helpers/detached-tree.ts";
import { pollGone, processRows } from "../helpers/process-liveness.ts";

const DAEMON_DIR = "/packages/app-server-daemon/";

/** Blocks this thread until `done`, as a SIGSTOP the walk sends must wait on the `exec`. */
function waitSync(done: () => boolean): void {
  const deadline = performance.now() + 5_000;
  while (!done()) {
    if (performance.now() > deadline) throw new Error("the process never became the daemon");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
  }
}

describe("C-LIFE-10 Codex's daemon, stopped as it starts (real processes)", () => {
  test.skipIf(process.platform !== "darwin")(
    "a group stopped as its process became the daemon is resumed, not killed",
    async () => {
      const tree = startDetachedTree("becomes-daemon");
      const [child, grandchild] = await detachedDescendantPids(tree);
      const becoming = await extraPid(tree, "becoming");
      const command = () => processRows(10_000).find((row) => row.pid === becoming)?.command;
      expect(command()).not.toContain(DAEMON_DIR);
      // It becomes the daemon after the walk read its path, before the walk's SIGSTOP.
      const stopGroup = (pgid: number) => {
        if (pgid === becoming) {
          writeFileSync(join(tree.dir, "exec"), "");
          waitSync(() => existsSync(join(tree.dir, "became")));
        }
        osProcessTreeOps.stopGroup(pgid);
      };
      const reaper = new SessionReaper(tree.pty.pid, { ...osProcessTreeOps, stopGroup });
      await reaper.sweepDetached(() => false);
      reaper.reap();
      expect(await pollGone({ pid: child, timeoutMs: 5_000 })).toBe(true);
      expect(await pollGone({ pid: grandchild, timeoutMs: 5_000 })).toBe(true);
      // Running again, and still this tree's process, not a reuse of its pid.
      const row = processRows(10_000).find((entry) => entry.pid === becoming);
      expect(row?.command).toContain(`${tree.dir}${DAEMON_DIR}`);
      expect(row?.stat).toMatch(/^[^TZ]/);
    },
  );
});
