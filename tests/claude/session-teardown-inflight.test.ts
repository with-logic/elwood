/**
 * C-LIFE-11: teardown reaps and completes even while rejecting an interrupted
 * operation — a queued-before-ready message and each genuinely in-flight op the
 * PRD names (compact, setModel, listModels). Covers PRD §5.3/§9.4 (C-LIFE-10/11).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { startClaude } from "../../src/index.ts";
import { installFakes, ptys, reapedGroups, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

describe("ClaudeSessionApi teardown with an interrupted operation", () => {
  test("C-LIFE-11 teardown reaps and completes even when it rejects a QUEUED message", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    const leaderPid = ptys.at(-1)!.pid;
    const dir = join(cwd, ".elwood", "sessions", session.elwoodSessionId);
    reapedGroups.length = 0;
    // Queue a message while the session is not ready: it stays in the control
    // queue, unresolved, until a ready transition that never comes.
    const pending = session.sendMessage("queued-until-teardown");
    // Tearing down closes the control queue (rejecting the pending message) and
    // must still run every teardown step — group reap, runtime cleanup, and
    // session-dir removal — to completion.
    await session.teardown();
    await expect(pending).rejects.toMatchObject({ code: "session_not_running" });
    expect(session.status).toBe("torn_down");
    // The reap must actually happen on this rejecting path — the exact step that
    // would silently regress the original P0 leak (C-LIFE-10).
    expect(reapedGroups).toContain(leaderPid);
    expect(existsSync(dir)).toBe(false);
  });

  // C-LIFE-11 across the operations the PRD names as interruptible: each is
  // driven to be genuinely IN-FLIGHT (submitted after readiness, awaiting a hook
  // or picker that never arrives) before teardown rejects it — the distinct
  // ControlQueue.inFlight branch, not the queued-before-ready branch above.
  // listModels and setModel both route through the model picker and await a
  // picker frame that never renders here, so both are genuinely in-flight (unlike
  // sendMessage, which resolves the instant it writes — see VALIDATION-DECISIONS.md).
  for (const op of ["compact", "setModel", "listModels"] as const) {
    test(`C-LIFE-11 teardown reaps and completes even when it rejects an in-flight ${op}`, async () => {
      const cwd = tempDir();
      installFakes();
      const session = await startClaude({ cwd });
      const leaderPid = ptys.at(-1)!.pid;
      const dir = join(cwd, ".elwood", "sessions", session.elwoodSessionId);
      // Drive readiness so the operation submits and goes IN-FLIGHT, then never
      // settles (no PostCompact / no picker frame): it is pending at teardown.
      await ptys[0]!.dispatchHook(session.elwoodSessionId, {
        hook_event_name: "InstructionsLoaded",
        session_id: "claude-1",
        cwd,
        file_path: "/tmp/CLAUDE.md",
        memory_type: "Project",
        load_reason: "session_start",
      });
      const pending =
        op === "compact"
          ? session.compact()
          : op === "setModel"
            ? session.setModel("some-model")
            : session.listModels();
      await expect.poll(() => ptys[0]!.writes.length).toBeGreaterThan(0); // it submitted
      reapedGroups.length = 0;
      await session.teardown();
      await expect(pending).rejects.toMatchObject({ code: "session_not_running" });
      expect(session.status).toBe("torn_down");
      expect(reapedGroups).toContain(leaderPid);
      expect(existsSync(dir)).toBe(false);
    });
  }
});
