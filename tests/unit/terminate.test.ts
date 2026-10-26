/**
 * Focused coverage for `terminatePty`: signal, wait, escalate, and reap-on-every-path.
 * Covers PRD §5.3/§9.4 (C-LIFE-10) and §10 (C-ERR-01). All reaps use injected fake
 * killers — never a real system signal.
 */

import { describe, expect, test } from "vitest";
import type { PtyExit } from "../../src/pty/types.ts";
import { quietProcessTree, SessionReaper } from "../../src/runtime/shutdown/reap-tree.ts";
import { terminatePty } from "../../src/runtime/shutdown/terminate.ts";

const LEADER = 1000;

const deadPty = {
  pid: LEADER,
  onData: () => () => {},
  onExit: () => () => {},
  write: () => {},
  resize: () => "resized" as const,
  kill: () => {},
};
/** A PTY whose leader exits once SIGKILLed, as a real one does after the sweep. */
function killablePty() {
  let exited: ((exit: PtyExit) => void) | undefined;
  return {
    ...deadPty,
    onExit: (handler: (exit: PtyExit) => void) => {
      exited = handler;
      return () => {};
    },
    kill: (signal?: string) => {
      if (signal === "SIGKILL") queueMicrotask(() => exited?.({ exitCode: 0 }));
    },
  };
}
const throwingReaper = (code?: string) =>
  new SessionReaper(LEADER, {
    ...quietProcessTree(),
    killGroup: () => {
      throw Object.assign(new Error("reap failure"), code === undefined ? {} : { code });
    },
  });

describe("C-LIFE-10 terminatePty", () => {
  test("reaps the leader's group after exit", async () => {
    const killed: number[] = [];
    const reaper = new SessionReaper(LEADER, {
      ...quietProcessTree(),
      killGroup: (p) => killed.push(p),
    });
    await terminatePty(killablePty(), "SIGKILL", reaper, { gracefulMs: 0, forceMs: 10 });
    expect(killed).toEqual([LEADER]);
  });

  test("when BOTH termination and reaping fail, both causes are preserved", async () => {
    // The termination error wins as the thrown cause, but the reap failure must
    // NOT be silently dropped — its message and errno ride in the details (C-LIFE-10).
    const timeouts = { gracefulMs: 0, forceMs: 0 };
    const rejected = terminatePty(deadPty, "SIGKILL", throwingReaper("EPERM"), timeouts);
    await expect(rejected).rejects.toMatchObject({
      code: "termination_failed",
      message: "PTY did not exit after SIGKILL.",
      details: { reapError: "reap failure", reapErrno: "EPERM" },
    });
    await expect(
      terminatePty(deadPty, "SIGKILL", throwingReaper(), timeouts),
    ).rejects.not.toHaveProperty("details.reapErrno");
  });

  test("a throwing PTY kill is typed and still preserves the reap cause when both fail", async () => {
    // When pty.kill() throws a plain Error and the reap also fails, the rejection is
    // the documented `termination_failed` carrying BOTH the kill cause and the reap
    // cause — neither is dropped (C-LIFE-10, C-ERR-01).
    const throwingKillPty = {
      ...deadPty,
      kill: () => {
        throw new Error("kill exploded");
      },
    };
    await expect(
      terminatePty(throwingKillPty, "SIGKILL", throwingReaper(), { gracefulMs: 0, forceMs: 0 }),
    ).rejects.toMatchObject({
      code: "termination_failed",
      details: { cause: "kill exploded", reapError: "reap failure" },
    });
  });

  test("a throwing exit subscription is typed with its errno and the group is still reaped", async () => {
    const killed: number[] = [];
    const throwingOnExitPty = {
      ...deadPty,
      onExit: () => {
        throw Object.assign(new Error("onExit EBADF"), { code: "EBADF", syscall: "ioctl" });
      },
    };
    const reaper = new SessionReaper(LEADER, {
      ...quietProcessTree(),
      killGroup: (pgid) => killed.push(pgid),
    });
    await expect(
      terminatePty(throwingOnExitPty, "SIGTERM", reaper, { gracefulMs: 0, forceMs: 0 }),
    ).rejects.toMatchObject({
      code: "termination_failed",
      message: "Could not terminate the PTY: onExit EBADF",
      details: { cause: "onExit EBADF", errno: "EBADF", syscall: "ioctl" },
    });
    expect(killed).toEqual([LEADER]);
  });

  test("a non-Error reap failure is stringified into the diagnostic", async () => {
    // The reap killer throws a bare string (not an Error): its String() form is
    // still carried, never dropped, when termination also fails.
    const stringThrowReaper = new SessionReaper(LEADER, {
      ...quietProcessTree(),
      killGroup: () => {
        // biome-ignore lint/style/useThrowOnlyError: intentional non-Error throw for coverage of the String() path.
        throw "raw-string-failure";
      },
    });
    await expect(
      terminatePty(deadPty, "SIGKILL", stringThrowReaper, { gracefulMs: 0, forceMs: 0 }),
    ).rejects.toMatchObject({ details: { reapError: "raw-string-failure" } });
  });

  test("a SIGTERM timeout that escalates and also times out reports SIGKILL", async () => {
    // The reported signal must be the phase that actually failed: after a SIGTERM
    // timeout escalates to SIGKILL and that also times out, the operator is sent
    // to the SIGKILL phase, not misdirected back to SIGTERM.
    const signals: string[] = [];
    const neverExits = {
      ...deadPty,
      kill: (signal: string) => {
        signals.push(signal);
      },
    };
    await expect(
      terminatePty(
        neverExits,
        "SIGTERM",
        new SessionReaper(LEADER, { ...quietProcessTree(), killGroup: () => {} }),
        {
          gracefulMs: 0,
          forceMs: 0,
        },
      ),
    ).rejects.toThrow("PTY did not exit after SIGKILL.");
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("a reap-ONLY failure (termination succeeded) wraps as typed termination_failed", async () => {
    // C-LIFE-10: PTY exited cleanly but the group reap failed — the raw system error
    // must NOT escape unwrapped; stop()/kill() reject with a typed `termination_failed`
    // (PRD §10, C-ERR-01) whose normalized cause preserves errno.
    const epermReaper = new SessionReaper(LEADER, {
      ...quietProcessTree(),
      killGroup: () => {
        throw Object.assign(new Error("reap failure"), { code: "EPERM" });
      },
    });
    await expect(
      terminatePty(killablePty(), "SIGKILL", epermReaper, { gracefulMs: 0, forceMs: 10 }),
    ).rejects.toMatchObject({
      code: "termination_failed",
      details: { cause: "reap failure", errno: "EPERM" },
    });
  });
});
