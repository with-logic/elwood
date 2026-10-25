/**
 * Real-process proof that the detached sweep reaps descendants that left the leader's
 * process group. Covers PRD §5.3 and §9.4 (C-LIFE-10): Claude starts each hook command
 * with `setsid()`, so a hook in flight at teardown is in its own session and group, and
 * the leader-group SIGKILL alone leaves it running, reparented to PID 1. These tests
 * build that shape with real processes under a real PTY and drive the production
 * reaper (real `ps`, real signals), scoped to processes this test spawned.
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { listProcessTable } from "../../src/runtime/shutdown/process-table.ts";
import { SessionReaper } from "../../src/runtime/shutdown/reap-tree.ts";
import {
  detachedDescendantPids,
  detachedShape,
  holdDir,
  killRecorded,
  killSurvivors,
  observedProcessShape,
  startDetachedTree,
} from "../helpers/detached-tree.ts";
import { pollGone } from "../helpers/process-liveness.ts";
import { startBystander } from "../helpers/setsid-pair.ts";

describe("C-LIFE-10 detached descendants (real processes)", () => {
  test("the sweep, then the group reap, end a setsid child and its own setsid grandchild", async () => {
    const tree = startDetachedTree();
    try {
      const [child, grandchild] = await detachedDescendantPids(tree);
      expect(await observedProcessShape([tree.pty.pid, child, grandchild])).toEqual(
        detachedShape(tree.pty.pid, child, grandchild),
      );
      const reaper = new SessionReaper(tree.pty.pid);
      await reaper.sweepDetached(() => false);
      reaper.reap();
      expect(await pollGone({ pid: child, timeoutMs: 5_000 })).toBe(true);
      expect(await pollGone({ pid: grandchild, timeoutMs: 5_000 })).toBe(true);
      expect(await pollGone({ pid: tree.pty.pid, timeoutMs: 5_000 })).toBe(true);
    } finally {
      await killSurvivors(tree);
    }
  });

  test("a detached process that is NOT a descendant of the leader is left alone", async () => {
    const tree = startDetachedTree();
    const bystander = startBystander();
    try {
      await detachedDescendantPids(tree);
      const reaper = new SessionReaper(tree.pty.pid);
      await reaper.sweepDetached(() => false);
      reaper.reap();
      // Running: present, not a zombie, and never stopped by the sweep.
      const table = await listProcessTable(10_000);
      expect(table.find((row) => row.pid === bystander.pid)).toMatchObject({
        zombie: false,
        stopped: false,
      });
    } finally {
      await killSurvivors(tree);
      bystander.kill("SIGKILL");
    }
  });

  test("cleanup of a partly started tree still kills a grandchild with no recorded parent", async () => {
    // A process starts its successor before recording its own pid, so a grandchild can
    // be recorded while its parent never is.
    const dir = holdDir("elwood-partial-");
    const grandchild = spawn(process.execPath, [join(dir, "hold.cjs"), dir, "grandchild"], {
      detached: true,
      stdio: "ignore",
    });
    try {
      await killRecorded(dir);
      expect(await pollGone({ pid: grandchild.pid as number, timeoutMs: 5_000 })).toBe(true);
    } finally {
      grandchild.kill("SIGKILL");
    }
  });
});
