/**
 * Real-process proof that the detached sweep reaps descendants that left the leader's
 * process group. Covers PRD §5.3 and §9.4 (C-LIFE-10): Claude starts each hook command
 * with `setsid()`, so a hook in flight at teardown is in its own session and group, and
 * the leader-group SIGKILL alone leaves it running, reparented to PID 1. These tests
 * build that shape with real processes under a real PTY and drive the production
 * reaper and `terminatePty` (real `ps`, real signals), scoped to processes this test
 * spawned.
 */

import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { listProcessTable } from "../../src/runtime/shutdown/process-table.ts";
import { SessionReaper } from "../../src/runtime/shutdown/reap-tree.ts";
import { terminatePty } from "../../src/runtime/shutdown/terminate.ts";
import {
  detachedDescendantPids,
  detachedShape,
  extraPid,
  holdDir,
  killTreeIn,
  observedProcessShape,
  startDetachedTree,
} from "../helpers/detached-tree.ts";
import { killGroupsWhoseCommandHas, pollGone, processRows } from "../helpers/process-liveness.ts";
import { startBystander, stopBystander } from "../helpers/setsid-pair.ts";

describe("C-LIFE-10 detached descendants (real processes)", () => {
  test("the sweep, then the group reap, end a setsid child and its own setsid grandchild", async () => {
    const tree = startDetachedTree();
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
  });

  test("kill reaps a setsid child and its own setsid grandchild", async () => {
    const tree = startDetachedTree();
    const [child, grandchild] = await detachedDescendantPids(tree);
    await terminatePty(tree.pty, "SIGKILL", new SessionReaper(tree.pty.pid));
    expect(await pollGone({ pid: child, timeoutMs: 5_000 })).toBe(true);
    expect(await pollGone({ pid: grandchild, timeoutMs: 5_000 })).toBe(true);
  });

  test("an ignored SIGTERM escalates and still reaps the detached descendants", async () => {
    const tree = startDetachedTree("ignore-term");
    const [child, grandchild] = await detachedDescendantPids(tree);
    expect(await observedProcessShape([tree.pty.pid, child, grandchild])).toEqual(
      detachedShape(tree.pty.pid, child, grandchild),
    );
    await terminatePty(tree.pty, "SIGTERM", new SessionReaper(tree.pty.pid), {
      gracefulMs: 300,
      forceMs: 5_000,
    });
    expect(await pollGone({ pid: child, timeoutMs: 5_000 })).toBe(true);
    expect(await pollGone({ pid: grandchild, timeoutMs: 5_000 })).toBe(true);
  });

  // Linux `ps` shows the executable's name as the command name, not argv[0]. The install
  // removed is the e2e suite's case: it removed homes whose daemons kept running.
  for (const install of ["in place", "removed"]) {
    test.skipIf(process.platform !== "darwin")(
      `kill never signals Codex's app-server daemon or its updater loop, its install ${install}`,
      async () => {
        const tree = startDetachedTree("with-daemon");
        const [child, grandchild] = await detachedDescendantPids(tree);
        const [daemon, updater, mcp] = await Promise.all([
          extraPid(tree, "daemon"),
          extraPid(tree, "updater"),
          extraPid(tree, "mcp"),
        ]);
        // As the Codex 0.164 TUI starts them: setsid children of its own, from its install.
        expect(await observedProcessShape([daemon, updater, mcp])).toEqual({
          [daemon]: `ppid=${tree.pty.pid} pgid=${daemon}`,
          [updater]: `ppid=${tree.pty.pid} pgid=${updater}`,
          [mcp]: `ppid=${daemon} pgid=${mcp}`,
        });
        if (install === "removed") rmSync(join(tree.dir, "packages"), { recursive: true });
        await terminatePty(tree.pty, "SIGKILL", new SessionReaper(tree.pty.pid));
        expect(await pollGone({ pid: child, timeoutMs: 5_000 })).toBe(true);
        expect(await pollGone({ pid: grandchild, timeoutMs: 5_000 })).toBe(true);
        const rows = processRows(10_000);
        for (const pid of [daemon, updater, mcp]) {
          // Running, and still this tree's process, not a reuse of its pid.
          const row = rows.find((entry) => entry.pid === pid);
          expect(row?.command).toContain(tree.dir);
          expect(row?.stat).toMatch(/^[^TZ]/);
        }
      },
    );
  }

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
      await stopBystander(bystander);
    }
  });

  test("cleanup finds a process running from the tree's directory by its command line", async () => {
    // Not by a pid file: a process starts its successor before recording its own pid,
    // and a timed-out test's directory may already be gone.
    const dir = holdDir("elwood-partial-");
    const grandchild = spawn(process.execPath, [join(dir, "hold.cjs"), dir, "grandchild"], {
      detached: true,
      stdio: "ignore",
    });
    try {
      await killTreeIn(dir);
      expect(await pollGone({ pid: grandchild.pid as number, timeoutMs: 5_000 })).toBe(true);
    } finally {
      grandchild.kill("SIGKILL");
    }
  });
});

// The second test reads what the first left: the cleanup under test runs only after a
// test has finished, so no single test can observe it.
describe("C-LIFE-10 a failed real-process test leaves no detached tree behind", () => {
  let left: { readonly dir: string; readonly pids: readonly number[] } | undefined;

  test.fails("a sweep that cannot read the table, then a throwing assertion", async () => {
    const tree = startDetachedTree();
    const [child, grandchild] = await detachedDescendantPids(tree);
    left = { dir: tree.dir, pids: [tree.pty.pid, child, grandchild] };
    const unreadable = Object.assign(new Error("ps failed"), { code: "EAGAIN" });
    const reaper = new SessionReaper(tree.pty.pid, {
      stopGroup: () => undefined,
      killGroup: () => undefined,
      listProcesses: () => Promise.reject(unreadable),
    });
    await expect(reaper.sweepDetached(() => false)).rejects.toThrow("process table unreadable");
    // The sweep reached nothing, so this fails, as a red run of these tests would.
    expect(await pollGone({ pid: grandchild, timeoutMs: 200 })).toBe(true);
  });

  test("once that test has finished, nothing runs from its tree and its directory is gone", async () => {
    expect(left).toBeDefined();
    const { dir, pids } = left as NonNullable<typeof left>;
    expect(killGroupsWhoseCommandHas(dir)).toBe(0);
    for (const pid of pids) expect(await pollGone({ pid, timeoutMs: 5_000 })).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });
});
