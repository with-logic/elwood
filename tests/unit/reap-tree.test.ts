/**
 * Focused coverage for the PTY process-group reaper.
 * Covers PRD §5.3 and §9.4 (C-LIFE-10).
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  reapProcessGroup,
  rethrowUnlessGroupGone,
  SessionReaper,
} from "../../src/runtime/shutdown/reap-tree.ts";

const LEADER = 1000;

afterEach(() => vi.restoreAllMocks());

describe("C-LIFE-10 process-group reaping", () => {
  test("SIGKILLs the leader's process group", () => {
    const killed: number[] = [];
    reapProcessGroup(LEADER, { killGroup: (pgid) => killed.push(pgid) });
    expect(killed).toEqual([LEADER]);
  });

  test("refuses only ids the kernel would misroute: pid 0, pid 1, and our own pid", () => {
    // pid 0 => "our own group", pid 1 => init/launchd, our own pid => kill(-pid)
    // hits our own group. None identifies an owned PTY leader; none may be signaled.
    // (A fake pid 1 in a reaper run once killed a dev's real apps — hence this guard.)
    const touched: number[] = [];
    for (const pid of [0, 1, process.pid]) {
      reapProcessGroup(pid, { killGroup: (p) => touched.push(p) });
    }
    expect(touched).toEqual([]);
  });

  test("reaps a low-but-valid owned leader pid — no arbitrary numeric floor", () => {
    // The leader pid is a KNOWN-OWNED node-pty leader; its value is an allocation
    // detail. After PID-space wrap or in a constrained namespace it can be low
    // (e.g. 42). The prior `< 100` floor silently no-op'd such leaders and leaked
    // their descendants; killGroup MUST fire for a low, valid, injected fake pid.
    const killed: number[] = [];
    reapProcessGroup(42, { killGroup: (pgid) => killed.push(pgid) });
    expect(killed).toEqual([42]);
  });

  test("the default killer signals the negative pgid and swallows an already-gone group", () => {
    // `process.kill` is stubbed so no real group is ever signaled: the default killer
    // must target -pgid with SIGKILL and treat ESRCH (group already empty) as success.
    const signaled: [number, string][] = [];
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      signaled.push([pid, String(signal)]);
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    });
    expect(() => reapProcessGroup(LEADER)).not.toThrow();
    expect(signaled).toEqual([[-LEADER, "SIGKILL"]]);
  });

  test("the default killer rethrows a real kill failure such as EPERM", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    });
    expect(() => reapProcessGroup(LEADER)).toThrow("denied");
  });

  test("swallows ESRCH but re-throws any other kill failure", () => {
    expect(() => rethrowUnlessGroupGone({ code: "ESRCH" })).not.toThrow();
    expect(() => rethrowUnlessGroupGone({ code: "EPERM" })).toThrow();
  });

  test("preserves a null / non-Error thrown value instead of a secondary TypeError", () => {
    // C-ERR-01: reading `.code` off a bare null/string must NOT throw a TypeError that
    // replaces the original failure — the exact thrown value is rethrown unchanged.
    expect(() => rethrowUnlessGroupGone(null)).toThrow();
    let caught: unknown;
    try {
      rethrowUnlessGroupGone(null);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeNull(); // the original value, not a TypeError about reading `.code`
    let thrown: unknown;
    try {
      rethrowUnlessGroupGone("boom");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe("boom"); // the exact bare-string value is preserved
  });

  test("SessionReaper reaps exactly once on success; later calls are reuse-safe no-ops", () => {
    // Reaping the same pgid twice is unsafe: once the group empties the kernel may
    // recycle the pid, so a second kill(-pgid) could hit an unrelated group. The
    // latch guarantees at most one SUCCESSFUL signal per session.
    const killed: number[] = [];
    const reaper = new SessionReaper(LEADER, { killGroup: (pgid) => killed.push(pgid) });
    reaper.reap();
    reaper.reap();
    reaper.reap();
    expect(killed).toEqual([LEADER]);
  });

  test("SessionReaper does NOT latch on a failed kill: the reap stays retryable", () => {
    // A real kill failure (e.g. EPERM) must not mark the reaper done — else a later
    // teardown no-ops and the leak survives. The failing call rethrows; on retry it
    // succeeds once the killer recovers.
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
    // pid 1 is refused by the guard, so the default killer performs no real signal
    // — exercising the no-injected-killer path safely.
    expect(() => new SessionReaper(1).reap()).not.toThrow();
  });
});
