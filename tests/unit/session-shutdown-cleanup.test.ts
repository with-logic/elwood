/**
 * Coverage for runShutdown folding a runtime-cleanup failure into the stable
 * public `termination_failed` error (PRD §10, C-LIFE-10). `runCleanupSteps` rejects
 * with a bare Error on the assumption its caller wraps it; stop()/kill() are that
 * caller, so a cleanup failure must not escape the shutdown boundary untyped.
 */

import { describe, expect, test } from "vitest";
import type { PtyProcess } from "../../src/pty/types.ts";
import { runShutdown, type ShutdownHost } from "../../src/runtime/session/shutdown.ts";
import type { ShutdownContext } from "../../src/runtime/shutdown/coordinator.ts";

/** A PTY the already-signaled hosts below never touch (no signal is ever re-sent). */
const untouchedPty: PtyProcess = {
  pid: 1000,
  onData: () => () => {},
  onExit: () => () => {},
  write: () => {},
  resize: () => "resized",
  kill: () => {
    throw new Error("an already-signaled session must not be re-signaled");
  },
};

// A host whose runtime cleanup rejects with a raw aggregate Error (as runCleanupSteps
// does). The session is treated as already-signaled so runShutdown takes the
// no-re-signal branch straight into cleanup, isolating the wrapping under test.
function host(
  cleanupRuntime: () => Promise<void>,
  overrides: Partial<ShutdownHost> = {},
): ShutdownHost {
  return {
    pty: untouchedPty,
    stateDir: "/tmp/state",
    elwoodSessionId: "s1",
    socketHome: "/tmp/elwood-x",
    reapPolicy: { orThrow: () => undefined, reaper: { reap: () => undefined } },
    status: () => "exited",
    claimShutdown: () => undefined,
    pauseLoops: () => undefined,
    clearLoops: () => Promise.resolve(),
    cleanupRuntime,
    submitEvidence: () => undefined,
    ...overrides,
  };
}

const signaledCtx: ShutdownContext = { alreadySignaled: true, markSignaled: () => undefined };

describe("runShutdown runtime-cleanup failure (C-LIFE-10)", () => {
  test("C-ERR-01 a rejecting cleanupRuntime surfaces as typed termination_failed", async () => {
    const failing = host(() => Promise.reject(new Error("Runtime cleanup failed: bridge stop")));
    await expect(
      runShutdown(failing, "SIGTERM", "stop_completed", signaledCtx),
    ).rejects.toMatchObject({
      code: "termination_failed",
      details: { cause: "Runtime cleanup failed: bridge stop" },
    });
  });

  test("C-ERR-01 a non-Error cleanup rejection is stringified into the cause", async () => {
    const failing = host(() => Promise.reject("boom"));
    await expect(
      runShutdown(failing, "SIGTERM", "stop_completed", signaledCtx),
    ).rejects.toMatchObject({ code: "termination_failed", details: { cause: "boom" } });
  });

  test("cleanup succeeding resolves without a termination error", async () => {
    await expect(
      runShutdown(
        host(() => Promise.resolve()),
        "SIGTERM",
        "stop_completed",
        signaledCtx,
      ),
    ).resolves.toBeUndefined();
  });
});
