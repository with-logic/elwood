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

// Any pid but the test process's own: SessionReaper refuses to signal that one.
const LEADER = process.pid + 1;

const endingWith = (failure?: unknown): StartupPty => ({
  pid: LEADER,
  terminate: () => (failure === undefined ? Promise.resolve() : Promise.reject(failure)),
});

const startFailed = () =>
  elwoodError("claude_start_failed", "claude exited during startup.", { exitCode: 1 });

/** What the guarded region rejects with when startup fails and the PTY end does `failure`. */
function rejectionAfter(failure: unknown, original = startFailed()): Promise<unknown> {
  return guardStartupRegion(() => Promise.reject(original), {
    pty: endingWith(failure),
  }).then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("C-ERR-08 startup cleanup diagnostic", () => {
  // A raw errno comes from a post-exit reap and a typed one from the PTY termination.
  // When termination and reap both fail, the reap's errno is the one reported.
  test.each([
    ["a raw post-exit reap errno", Object.assign(new Error("kill EPERM"), { code: "EPERM" })],
    [
      "a typed termination errno",
      elwoodError("termination_failed", "PTY exited but…", { errno: "EPERM" }),
    ],
    [
      "a reap errno over the termination's",
      elwoodError("termination_failed", "PTY did not exit after SIGKILL.", {
        errno: "ESRCH",
        reapError: "kill EPERM",
        reapErrno: "EPERM",
      }),
    ],
  ])("%s is named on the typed startup error", async (_case, failure) => {
    const original = startFailed();
    const error = await rejectionAfter(failure, original);
    expect(error).toBeInstanceOf(ElwoodError);
    expect(error).toMatchObject({
      code: "claude_start_failed",
      message: "claude exited during startup.",
      stack: original.stack,
    });
    expect((error as ElwoodError).details).toEqual({
      exitCode: 1,
      cleanupErrorCode: "EPERM",
      cleanupProcessGroupId: LEADER,
    });
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

  // A PTY that never reported exit carries no errno; an errno outside the allowlist, or
  // a thrown non-error, is never echoed either.
  test.each([
    ["an unexited PTY", elwoodError("termination_failed", "PTY did not exit after SIGKILL.")],
    ["a non-allowlisted errno", Object.assign(new Error("odd"), { code: "ENOTALLOWLISTED" })],
    ["a thrown non-error", "not an error"],
  ])("%s is reported as UnknownError", async (_case, failure) => {
    expect(((await rejectionAfter(failure)) as ElwoodError).details).toEqual({
      exitCode: 1,
      cleanupErrorCode: "UnknownError",
      cleanupProcessGroupId: LEADER,
    });
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
