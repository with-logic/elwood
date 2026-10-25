/**
 * Public-path coverage for the startup-cleanup diagnostic (PRD §9.1, C-ERR-08): a
 * Claude start or resume whose group reap cannot be confirmed rejects with its original
 * typed error, which now names the unconfirmed reap. Group kills reach an injected fake
 * killer only; no real signal is issued.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { resumeClaude, startClaude } from "../../src/index.ts";
import { setPtyFactoryForTests } from "../../src/runtime/seams.ts";
import {
  exitingDuringStartup,
  refuseGroupKills,
  rejection,
  runningWithStartupOutput,
  startupExit,
} from "../helpers/startup-exit.ts";
import { installFakes, ptys, reapedGroups, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

describe("C-ERR-08 an unconfirmed reap on a failed Claude start", () => {
  test("a fresh start names it on the typed error", async () => {
    installFakes();
    refuseGroupKills();
    setPtyFactoryForTests(exitingDuringStartup(ptys));
    const failure = await rejection(startClaude({ cwd: tempDir() }));
    expect(failure.code).toBe("claude_start_failed");
    expect(failure.message).toBe("claude exited during startup.");
    expect(failure.details).toEqual({
      ...startupExit,
      cleanupErrorCode: "EPERM",
      cleanupProcessGroupId: ptys[0]!.pid,
    });
    expect(ptys[0]!.killSignals).toEqual([]);
  });

  test("a running CLI whose signal throws names that errno, and its group is reaped", async () => {
    installFakes();
    const running = runningWithStartupOutput(ptys, "not authenticated");
    setPtyFactoryForTests((options) => {
      const pty = running(options);
      vi.spyOn(pty, "kill").mockImplementation(() => {
        throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
      });
      return pty;
    });
    const failure = await rejection(startClaude({ cwd: tempDir() }));
    expect(failure.code).toBe("claude_not_authenticated");
    expect(failure.details).toEqual({
      cleanupErrorCode: "ESRCH",
      cleanupProcessGroupId: ptys[0]!.pid,
    });
    expect(reapedGroups).toEqual([ptys[0]!.pid]);
  });

  test("a resume names it too", async () => {
    installFakes();
    const cwd = tempDir();
    const original = await startClaude({ cwd });
    await ptys[0]!.dispatchHook(original.elwoodSessionId, {
      hook_event_name: "SessionStart",
      session_id: "claude-resume",
      cwd,
      source: "startup",
    });
    await original.stop();
    refuseGroupKills();
    setPtyFactoryForTests(exitingDuringStartup(ptys));
    const failure = await rejection(
      resumeClaude({ cwd, elwoodSessionId: original.elwoodSessionId }),
    );
    expect(failure.code).toBe("claude_start_failed");
    expect(failure.details).toEqual({
      ...startupExit,
      cleanupErrorCode: "EPERM",
      cleanupProcessGroupId: ptys[1]!.pid,
    });
    expect(ptys[1]!.killSignals).toEqual([]);
  });
});
