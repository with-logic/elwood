/**
 * Coverage for runShutdown folding a runtime-cleanup failure into the stable
 * public `termination_failed` error (PRD §10, C-LIFE-10). `runCleanupSteps` rejects
 * with a bare Error on the assumption its caller wraps it; stop()/kill() are that
 * caller, so a cleanup failure must not escape the shutdown boundary untyped.
 */

import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { elwoodError } from "../../src/core/errors.ts";
import {
  managedShutdown,
  runShutdown,
  runTeardown,
  type ShutdownHost,
} from "../../src/runtime/session-shutdown.ts";
import {
  type ShutdownContext,
  ShutdownCoordinator,
} from "../../src/runtime/shutdown-coordinator.ts";
import {
  createSessionRecord,
  prepareStateDir,
  sessionDir,
  writeSessionRecord,
} from "../../src/state/store.ts";

// A host whose runtime cleanup rejects with a raw aggregate Error (as runCleanupSteps
// does). The session is treated as already-signaled so runShutdown takes the
// no-re-signal branch straight into cleanup, isolating the wrapping under test.
function host(
  cleanupRuntime: () => Promise<void>,
  overrides: Partial<ShutdownHost> = {},
): ShutdownHost {
  return {
    pty: {} as never,
    stateDir: "/tmp/state",
    elwoodSessionId: "s1",
    socketPath: "/tmp/elwood-x/h.sock",
    reapPolicy: { orThrow: () => undefined, reaper: {} as never } as never,
    status: () => "exited",
    claimShutdown: () => undefined,
    clearLoops: () => Promise.resolve(),
    cleanupRuntime,
    submitEvidence: () => undefined,
    ...overrides,
  };
}

const signaledCtx = { alreadySignaled: true, markSignaled: () => undefined } as ShutdownContext;

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

describe("permanent loop clearing (C-LOOP-14/C-LOOP-19)", () => {
  test("stop preserves loops while kill clears them before attempt-all cleanup", async () => {
    const calls: string[] = [];
    const shutdownHost = host(async () => void calls.push("cleanup"), {
      clearLoops: async (reason) => void calls.push(`clear:${reason}`),
      reapPolicy: { orThrow: () => void calls.push("reap"), reaper: {} as never } as never,
    });
    const shutdown = managedShutdown(new ShutdownCoordinator(), () => shutdownHost);
    await shutdown.stop();
    expect(calls).toEqual(["reap", "cleanup"]);
    calls.length = 0;
    await shutdown.kill();
    expect(calls).toEqual(["clear:kill", "reap", "cleanup"]);
  });

  test("kill preserves loop_persistence_failed but still reaps and cleans runtime", async () => {
    const calls: string[] = [];
    const shutdownHost = host(async () => void calls.push("cleanup"), {
      clearLoops: () => {
        calls.push("clear");
        return Promise.reject(
          elwoodError("loop_persistence_failed", "Could not clear loop state."),
        );
      },
      reapPolicy: { orThrow: () => void calls.push("reap"), reaper: {} as never } as never,
    });
    const shutdown = managedShutdown(new ShutdownCoordinator(), () => shutdownHost);
    await expect(shutdown.kill()).rejects.toMatchObject({ code: "loop_persistence_failed" });
    expect(calls).toEqual(["clear", "reap", "cleanup"]);
  });

  test("kill still reports termination failure when loop clearing succeeds", async () => {
    const shutdownHost = host(() => Promise.reject(new Error("cleanup failed")));
    const shutdown = managedShutdown(new ShutdownCoordinator(), () => shutdownHost);
    await expect(shutdown.kill()).rejects.toMatchObject({ code: "termination_failed" });
  });

  test("teardown preserves loop_persistence_failed but still removes session files", async () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-shutdown-loops-"));
    prepareStateDir(root);
    const id = "teardown-loop-failure";
    const dir = sessionDir(root, id);
    writeSessionRecord(createSessionRecord({ cwd: root, id }), dir);
    const calls: string[] = [];
    const shutdownHost = host(async () => void calls.push("cleanup"), {
      stateDir: root,
      elwoodSessionId: id,
      clearLoops: (reason) => {
        calls.push(`clear:${reason}`);
        return Promise.reject(
          elwoodError("loop_persistence_failed", "Could not clear loop state."),
        );
      },
      reapPolicy: {
        orThrow: () => undefined,
        reaper: { reap: async () => void calls.push("reap") },
      } as never,
      submitEvidence: () => void calls.push("evidence"),
    });
    await expect(runTeardown(shutdownHost, signaledCtx)).rejects.toMatchObject({
      code: "loop_persistence_failed",
    });
    expect(calls).toEqual(["clear:teardown", "reap", "cleanup", "evidence"]);
    expect(existsSync(dir)).toBe(false);
  });
});
