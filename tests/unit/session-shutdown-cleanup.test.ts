/**
 * Coverage for runShutdown's runtime cleanup (PRD §9.4 and §10, C-LIFE-10): it runs
 * after every stop()/kill() attempt, even one whose termination or reap failed, and
 * its failure surfaces as the stable public `termination_failed` error. `runCleanupSteps`
 * rejects with a bare Error on the assumption its caller wraps it; stop()/kill() are
 * that caller, so a cleanup failure must not escape the shutdown boundary untyped.
 */

import { describe, expect, test } from "vitest";
import { elwoodError } from "../../src/core/errors.ts";
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

/** A reaper whose reap and detached sweep always succeed. */
const quietReaper: ShutdownHost["reapPolicy"]["reaper"] = {
  reap: () => undefined,
  reapAndThrowOnDetachedSweepFailure: () => undefined,
  sweepDetached: async () => {},
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
    removeFiles: () => undefined,
    reapPolicy: {
      orThrow: () => undefined,
      reaper: quietReaper,
    },
    status: () => "exited",
    claimShutdown: () => undefined,
    pauseLoops: () => undefined,
    clearOrPauseLoops: () => Promise.resolve(),
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

const reapFailed = elwoodError("termination_failed", "Could not reap the PTY process group.", {
  errno: "EPERM",
  processGroupId: 1000,
});

describe("C-LIFE-10 runtime cleanup after a failed termination", () => {
  test("a retry whose reap fails still cleans up, rejecting with the reap failure", async () => {
    let cleanups = 0;
    const failing = host(
      () => {
        cleanups += 1;
        return Promise.resolve();
      },
      {
        reapPolicy: {
          orThrow: () => {
            throw reapFailed;
          },
          reaper: quietReaper,
        },
      },
    );
    await expect(runShutdown(failing, "SIGKILL", "kill_completed", signaledCtx)).rejects.toBe(
      reapFailed,
    );
    expect(cleanups).toBe(1);
  });

  test("a cleanup failure alongside it rides along in details.cleanupError", async () => {
    const failing = host(() => Promise.reject(new Error("Runtime cleanup failed: bridge stop")), {
      reapPolicy: {
        orThrow: () => {
          throw reapFailed;
        },
        reaper: quietReaper,
      },
    });
    await expect(
      runShutdown(failing, "SIGTERM", "stop_completed", signaledCtx),
    ).rejects.toMatchObject({
      code: "termination_failed",
      message: "Could not reap the PTY process group.",
      details: {
        errno: "EPERM",
        processGroupId: 1000,
        cleanupError: "Runtime cleanup failed: bridge stop",
      },
    });
  });

  test("a live kill whose PTY signal throws still cleans up and records no evidence", async () => {
    let cleanups = 0;
    const evidence: string[] = [];
    const throwing: PtyProcess = {
      ...untouchedPty,
      kill: () => {
        throw new Error("kill failed");
      },
    };
    const live = host(
      () => {
        cleanups += 1;
        return Promise.resolve();
      },
      { pty: throwing, status: () => "ready", submitEvidence: (kind) => void evidence.push(kind) },
    );
    const liveCtx: ShutdownContext = { alreadySignaled: false, markSignaled: () => undefined };
    await expect(runShutdown(live, "SIGKILL", "kill_completed", liveCtx)).rejects.toMatchObject({
      code: "termination_failed",
      message: "Could not terminate the PTY: kill failed",
    });
    expect(cleanups).toBe(1);
    expect(evidence).toEqual([]);
  });

  test("C-ERR-01 an untyped termination failure is still typed termination_failed", async () => {
    const failing = host(() => Promise.resolve(), {
      reapPolicy: {
        orThrow: () => {
          throw Object.assign(new Error("raw reap"), { code: "EIO" });
        },
        reaper: quietReaper,
      },
    });
    await expect(
      runShutdown(failing, "SIGTERM", "stop_completed", signaledCtx),
    ).rejects.toMatchObject({
      code: "termination_failed",
      message: "raw reap",
      details: { cause: "raw reap", errno: "EIO" },
    });
  });
});
