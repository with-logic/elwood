/**
 * Loop persistence across explicit shutdowns (PRD §8.4, C-LOOP-14/C-LOOP-19): `stop`
 * pauses live timers but keeps definitions; `kill` clears them only after termination
 * succeeds; `teardown` clears them and still removes session files when clearing fails.
 */

import { existsSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { elwoodError } from "../../src/core/errors.ts";
import type { PtyProcess } from "../../src/pty/types.ts";
import {
  managedShutdown,
  runTeardown,
  type ShutdownHost,
  type ShutdownReapPolicy,
} from "../../src/runtime/session/shutdown.ts";
import {
  type ShutdownContext,
  ShutdownCoordinator,
} from "../../src/runtime/shutdown/coordinator.ts";
import {
  createSessionRecord,
  prepareStateDir,
  sessionDir,
  writeSessionRecord,
} from "../../src/state/store.ts";
import { tempDir } from "../helpers/tmp.ts";

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

/** A reap policy that records each reap (never latching, so retries stay visible). */
function recordingReap(calls: string[]): ShutdownReapPolicy {
  return {
    orThrow: () => void calls.push("reap"),
    reaper: { reap: () => void calls.push("reap") },
  };
}

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

describe("permanent loop clearing (C-LOOP-14/C-LOOP-19)", () => {
  test("stop pauses live loops but preserves them; a successful kill pauses then clears them", async () => {
    const calls: string[] = [];
    const shutdownHost = host(async () => void calls.push("cleanup"), {
      pauseLoops: () => void calls.push("pause"),
      clearLoops: async (reason) => void calls.push(`clear:${reason}`),
      reapPolicy: recordingReap(calls),
    });
    const shutdown = managedShutdown(new ShutdownCoordinator(), () => shutdownHost);
    await shutdown.stop();
    expect(calls).toEqual(["pause", "reap", "cleanup"]); // no clear: definitions survive stop
    calls.length = 0;
    await shutdown.kill();
    expect(calls).toEqual(["pause", "reap", "cleanup", "clear:kill"]);
  });

  test("a failed kill preserves loops and retries clearing only after cleanup succeeds", async () => {
    const calls: string[] = [];
    let cleanupAttempts = 0;
    const shutdownHost = host(
      () => {
        calls.push("cleanup");
        cleanupAttempts += 1;
        return cleanupAttempts === 1
          ? Promise.reject(new Error("cleanup failed"))
          : Promise.resolve();
      },
      {
        pauseLoops: () => void calls.push("pause"),
        clearLoops: async () => void calls.push("clear"),
        reapPolicy: recordingReap(calls),
      },
    );
    const shutdown = managedShutdown(new ShutdownCoordinator(), () => shutdownHost);
    await expect(shutdown.kill()).rejects.toMatchObject({ code: "termination_failed" });
    expect(calls).toEqual(["pause", "reap", "cleanup"]);
    await shutdown.kill();
    expect(calls).toEqual(["pause", "reap", "cleanup", "pause", "reap", "cleanup", "clear"]);
  });

  test("kill reports loop persistence failure after cleanup succeeds", async () => {
    const calls: string[] = [];
    const shutdownHost = host(async () => void calls.push("cleanup"), {
      pauseLoops: () => void calls.push("pause"),
      clearLoops: () => {
        calls.push("clear");
        return Promise.reject(
          elwoodError("loop_persistence_failed", "Could not clear loop state."),
        );
      },
      reapPolicy: recordingReap(calls),
    });
    await expect(
      managedShutdown(new ShutdownCoordinator(), () => shutdownHost).kill(),
    ).rejects.toMatchObject({
      code: "loop_persistence_failed",
    });
    expect(calls).toEqual(["pause", "reap", "cleanup", "clear"]);
  });

  test("kill still reports termination failure when loop clearing succeeds", async () => {
    const shutdownHost = host(() => Promise.reject(new Error("cleanup failed")));
    const shutdown = managedShutdown(new ShutdownCoordinator(), () => shutdownHost);
    await expect(shutdown.kill()).rejects.toMatchObject({ code: "termination_failed" });
  });

  test("teardown reports cleanup failure when loop clearing succeeds", async () => {
    const shutdownHost = host(() => Promise.reject(new Error("cleanup failed")));
    await expect(runTeardown(shutdownHost, signaledCtx)).rejects.toMatchObject({
      code: "teardown_failed",
      details: { causes: ["cleanup failed"] },
    });
  });

  test("teardown preserves loop_persistence_failed but still removes session files", async () => {
    const root = tempDir("elwood-shutdown-loops-");
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
      reapPolicy: recordingReap(calls),
      submitEvidence: () => void calls.push("evidence"),
    });
    await expect(runTeardown(shutdownHost, signaledCtx)).rejects.toMatchObject({
      code: "loop_persistence_failed",
    });
    expect(calls).toEqual(["clear:teardown", "reap", "cleanup", "evidence"]);
    expect(existsSync(dir)).toBe(false);
  });
});
