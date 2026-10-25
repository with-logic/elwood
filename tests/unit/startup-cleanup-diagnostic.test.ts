/**
 * Unit coverage for the startup-cleanup diagnostic (PRD §9.1, C-ERR-08): when a failed
 * startup cannot confirm its PTY termination or process-group reap, the typed startup
 * error keeps its code and message and names that unconfirmed cleanup with a content-free
 * errno token and a diagnostic-only group id. The session's PTY end is a fake here.
 */

import { describe, expect, test } from "vitest";
import { ElwoodError, elwoodError } from "../../src/core/errors.ts";
import { SessionReaper } from "../../src/runtime/shutdown/reap-tree.ts";
import { terminatePty } from "../../src/runtime/shutdown/terminate.ts";
import {
  cleanupStartupResources,
  guardStartupRegion,
  type StartupPty,
} from "../../src/runtime/startup/cleanup.ts";

const LEADER = 4242;

const endingWith = (failure?: unknown): StartupPty => ({
  pid: LEADER,
  terminate: () => (failure === undefined ? Promise.resolve() : Promise.reject(failure)),
});

const startFailed = () =>
  elwoodError("claude_start_failed", "claude exited during startup.", { exitCode: 1 });

/** What the guarded region rejects with when startup fails and the PTY end does `failure`. */
function rejectionAfter(failure: unknown): Promise<unknown> {
  return guardStartupRegion(() => Promise.reject(startFailed()), {
    pty: endingWith(failure),
  }).then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("C-ERR-08 startup cleanup diagnostic", () => {
  test("an unconfirmed termination or reap is named on the typed startup error", async () => {
    // A raw errno comes from a post-exit reap and a typed one from the PTY termination.
    // When termination and reap both fail, the reap's errno is the one reported.
    for (const failure of [
      Object.assign(new Error("kill EPERM"), { code: "EPERM" }),
      elwoodError("termination_failed", "PTY exited but…", { errno: "EPERM" }),
      elwoodError("termination_failed", "PTY did not exit after SIGKILL.", {
        errno: "ESRCH",
        reapError: "kill EPERM",
        reapErrno: "EPERM",
      }),
    ]) {
      const error = await rejectionAfter(failure);
      expect(error).toBeInstanceOf(ElwoodError);
      expect(error).toMatchObject({
        code: "claude_start_failed",
        message: "claude exited during startup.",
      });
      expect((error as ElwoodError).details).toEqual({
        exitCode: 1,
        cleanupErrorCode: "EPERM",
        cleanupProcessGroupId: LEADER,
      });
    }
  });

  test("a PTY that never exits and a refused group kill report the reap's EPERM", async () => {
    // Real termination: SIGTERM and SIGKILL go unanswered, then the group kill is refused.
    const signals: string[] = [];
    const silent = {
      pid: LEADER,
      onData: () => () => {},
      onExit: () => () => {},
      write: () => {},
      resize: () => "resized" as const,
      kill: (signal = "SIGTERM") => void signals.push(signal),
    };
    const refusing = new SessionReaper(LEADER, {
      killGroup: () => {
        throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
      },
    });
    await expect(
      cleanupStartupResources({
        pty: { pid: LEADER, terminate: (t) => terminatePty(silent, "SIGTERM", refusing, t) },
        terminationTimeouts: { gracefulMs: 0, forceMs: 0 },
      }),
    ).resolves.toEqual({ cleanupErrorCode: "EPERM", cleanupProcessGroupId: LEADER });
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("a failure without an allowlisted errno is reported as UnknownError", async () => {
    // A PTY that never reported exit carries no errno; an errno outside the allowlist,
    // or a thrown non-error, is never echoed either.
    for (const failure of [
      elwoodError("termination_failed", "PTY did not exit after SIGKILL."),
      Object.assign(new Error("odd"), { code: "ENOTALLOWLISTED" }),
      "not an error",
    ]) {
      expect(((await rejectionAfter(failure)) as ElwoodError).details).toEqual({
        exitCode: 1,
        cleanupErrorCode: "UnknownError",
        cleanupProcessGroupId: LEADER,
      });
    }
  });

  test("a confirmed cleanup rethrows the original startup error itself", async () => {
    const original = startFailed();
    await expect(
      guardStartupRegion(() => Promise.reject(original), { pty: endingWith() }),
    ).rejects.toBe(original);
  });

  test("a startup error that is not Elwood's own is rethrown unchanged", async () => {
    const thrown = new Error("unexpected");
    await expect(
      guardStartupRegion(() => Promise.reject(thrown), {
        pty: endingWith(Object.assign(new Error("kill EPERM"), { code: "EPERM" })),
      }),
    ).rejects.toBe(thrown);
    expect(thrown).not.toHaveProperty("details");
  });
});
