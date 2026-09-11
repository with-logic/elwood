/**
 * Focused coverage for `terminatePty`: signal, wait, escalate, and reap-on-every-path.
 * Covers PRD §5.3/§9.4 (C-LIFE-10) and §10 (C-ERR-01). All reaps use injected fake
 * killers — never a real system signal.
 */

import { describe, expect, test } from "vitest";
import type { PtyExit } from "../../src/pty/types.ts";
import { SessionReaper } from "../../src/runtime/shutdown/reap-tree.ts";
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
const exitingPty = {
  ...deadPty,
  onExit: (handler: (exit: PtyExit) => void) => {
    queueMicrotask(() => handler({ exitCode: 0 }));
    return () => {};
  },
};
const throwingReaper = () =>
  new SessionReaper(LEADER, {
    killGroup: () => {
      throw new Error("reap failure");
    },
  });

describe("C-LIFE-10 terminatePty", () => {
  test("reaps the leader's group after exit", async () => {
    const killed: number[] = [];
    const reaper = new SessionReaper(LEADER, { killGroup: (p) => killed.push(p) });
    await terminatePty(exitingPty, "SIGKILL", reaper, { gracefulMs: 0, forceMs: 10 });
    expect(killed).toEqual([LEADER]);
  });

  test("when BOTH termination and reaping fail, both causes are preserved", async () => {
    // The termination error wins as the thrown cause, but the reap failure must
    // NOT be silently dropped — it is carried in the error's details (C-LIFE-10).
    await expect(
      terminatePty(deadPty, "SIGKILL", throwingReaper(), { gracefulMs: 0, forceMs: 0 }),
    ).rejects.toMatchObject({
      code: "termination_failed",
      details: { reapError: "reap failure" },
    });
  });

  test("a PLAIN-Error termination still preserves the reap cause when both fail", async () => {
    // When pty.kill() throws a plain Error (not an ElwoodError) and the reap also
    // fails, the original error keeps its identity/message AND carries the reap
    // cause on `.reapError` — neither cause is dropped (C-LIFE-10).
    const throwingKillPty = {
      ...deadPty,
      kill: () => {
        throw new Error("kill exploded");
      },
    };
    await expect(
      terminatePty(throwingKillPty, "SIGKILL", throwingReaper(), { gracefulMs: 0, forceMs: 0 }),
    ).rejects.toMatchObject({ message: "kill exploded", reapError: "reap failure" });
  });

  test("a non-Error reap failure is stringified into the diagnostic", async () => {
    // The reap killer throws a bare string (not an Error): its String() form is
    // still carried, never dropped, when termination also fails.
    const stringThrowReaper = new SessionReaper(LEADER, {
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
      terminatePty(neverExits, "SIGTERM", new SessionReaper(LEADER, { killGroup: () => {} }), {
        gracefulMs: 0,
        forceMs: 0,
      }),
    ).rejects.toThrow("PTY did not exit after SIGKILL.");
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("a reap-ONLY failure (termination succeeded) wraps as typed termination_failed", async () => {
    // C-LIFE-10: PTY exited cleanly but the group reap failed — the raw system error
    // must NOT escape unwrapped; stop()/kill() reject with a typed `termination_failed`
    // (PRD §10, C-ERR-01) whose normalized cause preserves errno.
    const epermReaper = new SessionReaper(LEADER, {
      killGroup: () => {
        throw Object.assign(new Error("reap failure"), { code: "EPERM" });
      },
    });
    await expect(
      terminatePty(exitingPty, "SIGKILL", epermReaper, { gracefulMs: 0, forceMs: 10 }),
    ).rejects.toMatchObject({
      code: "termination_failed",
      details: { cause: "reap failure", errno: "EPERM" },
    });
  });
});
