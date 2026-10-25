/**
 * Public-path coverage for the startup-cleanup diagnostic on Codex (PRD §9.1, C-ERR-08):
 * a start or resume whose group reap cannot be confirmed rejects with its original typed
 * error, which now names the unconfirmed reap. Group kills reach an injected fake killer
 * only; no real signal is issued.
 */

import { afterEach, describe, expect, test } from "vitest";
import { resumeCodex, startCodex } from "../../src/index.ts";
import { setPtyFactoryForTests } from "../../src/runtime/seams.ts";
import {
  exitingDuringStartup,
  refuseGroupKills,
  rejection,
  startupExit,
} from "../helpers/startup-exit.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

describe("C-ERR-08 an unconfirmed reap on a failed Codex start", () => {
  test("a fresh start names it on the typed error", async () => {
    installFakes();
    refuseGroupKills();
    setPtyFactoryForTests(exitingDuringStartup(ptys));
    const failure = await rejection(startCodex({ cwd: tempDir() }));
    expect(failure.code).toBe("codex_start_failed");
    expect(failure.message).toBe("codex exited during startup.");
    expect(failure.details).toEqual({
      ...startupExit,
      cleanupErrorCode: "EPERM",
      cleanupProcessGroupId: ptys[0]!.pid,
    });
    expect(ptys[0]!.killSignals).toEqual([]);
  });

  test("a resume names it too", async () => {
    installFakes();
    const cwd = tempDir();
    const original = await startCodex({ cwd });
    await ptys[0]!.dispatchHook(original.elwoodSessionId, {
      hook_event_name: "SessionStart",
      session_id: "codex-resume",
      cwd,
      source: "startup",
      model: "fixture",
    });
    await original.stop();
    refuseGroupKills();
    setPtyFactoryForTests(exitingDuringStartup(ptys));
    const failure = await rejection(
      resumeCodex({ cwd, elwoodSessionId: original.elwoodSessionId }),
    );
    expect(failure.code).toBe("codex_start_failed");
    expect(failure.details).toEqual({
      ...startupExit,
      cleanupErrorCode: "EPERM",
      cleanupProcessGroupId: ptys[1]!.pid,
    });
    expect(ptys[1]!.killSignals).toEqual([]);
  });
});
