/**
 * Unit coverage for the guarded startup region and startup-failure cleanup
 * (PRD §9.1/§9.4, C-LIFE-10): a failure AFTER the session's live resources exist
 * tears every one of them down before rethrowing, so a rejected startup never
 * leaks a PTY, bridge, terminal, or watcher — AND the PTY's process GROUP is reaped
 * through the same one-shot reap primitive the normal exit path uses, so a
 * hook-bridge grandchild reparented to PID 1 cannot survive a failed startup.
 * All reaps use an injected fake killer — no real signal is ever issued.
 */

import { afterEach, describe, expect, test } from "vitest";
import type { PtyExit } from "../../src/pty/types.ts";
import { resetGroupKillerForTests, setGroupKillerForTests } from "../../src/runtime/reap-tree.ts";
import { cleanupStartupResources, guardStartupRegion } from "../../src/runtime/startup-cleanup.ts";

const LEADER = 4242;
const fastTimeouts = { gracefulMs: 0, forceMs: 0 } as const;

/** A PTY whose leader exits promptly on the first signal (the common case). */
const fakePty = (killed: string[]) => ({
  pid: LEADER,
  onData: () => () => {},
  onExit: (handler: (exit: PtyExit) => void) => {
    queueMicrotask(() => handler({ exitCode: 0 }));
    return () => {};
  },
  write: () => {},
  resize: () => "resized" as const,
  kill: (signal = "SIGTERM") => void killed.push(signal),
});

afterEach(resetGroupKillerForTests);

describe("C-LIFE-10 guarded startup region", () => {
  test("a throwing region tears down every live resource before rethrowing", async () => {
    // The BLOCKER contract: a failure AFTER the session is live (e.g. a disk error in
    // the warning flush) must not leak the PTY, bridge, terminal, or watcher — the
    // region signals the pty, reaps its group, stops the bridge, disposes the
    // terminal, and runs `after`.
    const reaped: number[] = [];
    setGroupKillerForTests({ killGroup: (pgid) => reaped.push(pgid) });
    const killed: string[] = [];
    const calls: string[] = [];
    const region = () => Promise.reject(new Error("flush failed"));
    await expect(
      guardStartupRegion(region, {
        pty: fakePty(killed),
        bridge: { stop: () => Promise.resolve(void calls.push("bridge.stop")) },
        terminal: { dispose: () => void calls.push("terminal.dispose") },
        after: () => calls.push("watcher.stop"),
        terminationTimeouts: fastTimeouts,
      }),
    ).rejects.toThrow("flush failed");
    expect(killed).toEqual(["SIGTERM"]); // the now-live PTY was signaled, not leaked
    expect(reaped).toEqual([LEADER]); // and its process GROUP was reaped
    expect(calls).toEqual(["bridge.stop", "watcher.stop", "terminal.dispose"]);
  });

  test("a successful region runs no cleanup", async () => {
    const reaped: number[] = [];
    setGroupKillerForTests({ killGroup: (pgid) => reaped.push(pgid) });
    const killed: string[] = [];
    const calls: string[] = [];
    await guardStartupRegion(() => Promise.resolve(), {
      pty: fakePty(killed),
      bridge: { stop: () => Promise.resolve(void calls.push("bridge.stop")) },
      after: () => calls.push("watcher.stop"),
      terminationTimeouts: fastTimeouts,
    });
    expect(killed).toEqual([]);
    expect(reaped).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("C-LIFE-10 startup-failure group reap", () => {
  test("the process group is reaped even when the PTY signal throws", async () => {
    // A hook-bridge grandchild survives a failed startup unless the LEADER'S GROUP is
    // reaped. Even when pty.kill() throws (leader already gone / bad fd), the group
    // reap must still be ATTEMPTED — routed through the same primitive the exit path
    // uses — and cleanup must not resolve before that bounded work completes.
    const reaped: number[] = [];
    setGroupKillerForTests({ killGroup: (pgid) => reaped.push(pgid) });
    const throwingKillPty = {
      pid: LEADER,
      onData: () => () => {},
      onExit: () => () => {},
      write: () => {},
      resize: () => "resized" as const,
      kill: () => {
        throw new Error("kill exploded");
      },
    };
    await cleanupStartupResources({ pty: throwingKillPty, terminationTimeouts: fastTimeouts });
    expect(reaped).toEqual([LEADER]); // group reap attempted despite the throwing signal
  });

  test("a reap failure stays secondary and never escapes cleanup", async () => {
    // The original startup error must survive: a failing group reap (e.g. EPERM) is
    // contained inside cleanup, never rethrown to replace the startup error.
    setGroupKillerForTests({
      killGroup: () => {
        throw Object.assign(new Error("reap failure"), { code: "EPERM" });
      },
    });
    const killed: string[] = [];
    await expect(
      cleanupStartupResources({ pty: fakePty(killed), terminationTimeouts: fastTimeouts }),
    ).resolves.toBeUndefined();
  });
});
