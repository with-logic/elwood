/**
 * Real-CLI verification that teardown() reaps the agent process group with no
 * orphaned survivors (PRD §9.4, C-LIFE-10). This exercises the failure-safe,
 * retryable cleanup the review hardened (#1): after teardown the CLI child that
 * the PTY spawned under this test process must be gone.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { childPids } from "../../src/app/child-lookup.ts";
import { type ClaudeSessionApi, startClaude } from "../../src/index.ts";
import { cleanup, makeProject, skipReason, waitFor } from "./helpers.ts";

/** True once `pid` no longer exists (signal 0 probe throws ESRCH for a dead pid). */
function isReaped(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

test("C-LIFE-10 teardown reaps the real Claude process group (no orphan)", {
  skip: skipReason("claude"),
  timeout: 180_000,
}, async () => {
  const project = makeProject("claude");
  const before = new Set(childPids(process.pid));
  let starts = 0;
  const session: ClaudeSessionApi = await startClaude({
    cwd: project.cwd,
    stateDir: project.stateDir,
    autotrust: true,
    hooks: {
      SessionStart: () => {
        starts += 1;
      },
    },
  });
  // A failure in ANY assertion below must not leak the real process group into later
  // tests: the shared cleanup (teardown → kill fallback) always runs in `finally`.
  try {
    await waitFor(() => (starts > 0 ? true : undefined), "start SessionStart");
    // The CLI the PTY just spawned is a NEW direct child of this test process.
    const spawned = childPids(process.pid).filter((pid) => !before.has(pid));
    assert.ok(spawned.length >= 1, "the agent CLI is a live child of the test process");
    await session.teardown();
    // Every spawned leader (and thus its group) must be reaped; poll briefly for the
    // OS to finish tearing down the process group after teardown resolves.
    for (const pid of spawned) {
      await waitFor(() => (isReaped(pid) ? true : undefined), `pid ${pid} reaped`, 20_000);
      assert.ok(isReaped(pid), `agent pid ${pid} was reaped by teardown`);
    }
    // Teardown is idempotent and must not reject on a second call after exit.
    await session.teardown();
  } finally {
    await cleanup(session);
  }
});
