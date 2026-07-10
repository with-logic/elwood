/**
 * Focused coverage for the PTY process-group reaper.
 * Covers PRD §5.3 and §9.4 (C-LIFE-10).
 */

import { describe, expect, test } from "vitest";
import type { PtyExit } from "../../src/pty/types.ts";
import {
  reapProcessGroup,
  rethrowUnlessGroupGone,
  SessionReaper,
} from "../../src/runtime/reap-tree.ts";
import { terminatePty } from "../../src/runtime/terminate.ts";

const LEADER = 1000;

describe("C-LIFE-10 process-group reaping", () => {
  test("SIGKILLs the leader's process group", () => {
    const killed: number[] = [];
    reapProcessGroup(LEADER, { killGroup: (pgid) => killed.push(pgid) });
    expect(killed).toEqual([LEADER]);
  });

  test("refuses a system-range group id", () => {
    let touched = false;
    for (const pid of [1, 42, 99]) {
      reapProcessGroup(pid, {
        killGroup: () => {
          touched = true;
        },
      });
    }
    expect(touched).toBe(false);
  });

  test("real seams: reaping an already-dead group is a harmless no-op (ESRCH)", () => {
    // A high, almost-certainly-unused pid; the default killer must swallow ESRCH.
    expect(() => reapProcessGroup(999_999)).not.toThrow();
  });

  test("swallows ESRCH but re-throws any other kill failure", () => {
    expect(() => rethrowUnlessGroupGone({ code: "ESRCH" })).not.toThrow();
    expect(() => rethrowUnlessGroupGone({ code: "EPERM" })).toThrow();
  });

  test("SessionReaper reaps exactly once on success; later calls are reuse-safe no-ops", () => {
    // Reaping the same numeric pgid twice is unsafe: once the group empties the
    // kernel may recycle the pid, so a second kill(-pgid) could hit an unrelated
    // group. The latch guarantees at most one SUCCESSFUL signal per session.
    const killed: number[] = [];
    const reaper = new SessionReaper(LEADER, { killGroup: (pgid) => killed.push(pgid) });
    reaper.reap();
    reaper.reap();
    reaper.reap();
    expect(killed).toEqual([LEADER]);
  });

  test("SessionReaper does NOT latch on a failed kill: the reap stays retryable", () => {
    // A real kill failure (e.g. EPERM) must not mark the reaper done — otherwise a
    // later teardown no-ops and the descendant leak survives permanently. The
    // failing call rethrows; once the killer recovers, the retry succeeds.
    let attempts = 0;
    const reaper = new SessionReaper(LEADER, {
      killGroup: (pgid) => {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
        void pgid;
      },
    });
    expect(() => reaper.reap()).toThrow("EPERM"); // first attempt fails, does not latch
    expect(() => reaper.reap()).not.toThrow(); // retry succeeds
    expect(attempts).toBe(2);
    reaper.reap(); // now latched: no third attempt
    expect(attempts).toBe(2);
  });

  test("SessionReaper uses the default (real) killer when none is injected", () => {
    // A system-range pid is refused by the guard, so the default killer performs
    // no signal — exercising the no-injected-killer path safely.
    expect(() => new SessionReaper(1).reap()).not.toThrow();
  });

  test("terminatePty reaps the leader's group after exit", async () => {
    const killed: number[] = [];
    const pty = {
      pid: LEADER,
      onData: () => () => {},
      onExit: (handler: (exit: PtyExit) => void) => {
        queueMicrotask(() => handler({ exitCode: 0 }));
        return () => {};
      },
      write: () => {},
      resize: () => "resized" as const,
      kill: () => {},
    };
    await terminatePty(
      pty,
      "SIGKILL",
      new SessionReaper(LEADER, { killGroup: (p) => killed.push(p) }),
      {
        gracefulMs: 0,
        forceMs: 10,
      },
    );
    expect(killed).toEqual([LEADER]);
  });

  const deadPty = {
    pid: LEADER,
    onData: () => () => {},
    onExit: () => () => {},
    write: () => {},
    resize: () => "resized" as const,
    kill: () => {},
  };
  const throwingReaper = () =>
    new SessionReaper(LEADER, {
      killGroup: () => {
        throw new Error("reap failure");
      },
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

  test("a reap failure surfaces only when termination succeeded", async () => {
    const exitingPty = {
      ...deadPty,
      onExit: (handler: (exit: PtyExit) => void) => {
        queueMicrotask(() => handler({ exitCode: 0 }));
        return () => {};
      },
    };
    await expect(
      terminatePty(exitingPty, "SIGKILL", throwingReaper(), { gracefulMs: 0, forceMs: 10 }),
    ).rejects.toThrow("reap failure");
  });
});
