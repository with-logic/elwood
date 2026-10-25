/**
 * Unit coverage for the guarded startup region and startup-failure cleanup
 * (PRD §9.1/§9.4, C-LIFE-10): a failure AFTER the session's live resources
 * exist runs every cleanup step before rethrowing. The session ends its PTY first, then
 * the bridge, watcher, and terminal are released, and a failed step never skips a later
 * one. How the session ends the PTY and reaps its group is covered on the public paths in
 * `tests/claude/startup-pty-end.test.ts` and its Codex twin.
 */

import { describe, expect, test } from "vitest";
import {
  cleanupStartupResources,
  guardStartupRegion,
  type StartupPty,
} from "../../src/runtime/startup/cleanup.ts";

const fastTimeouts = { gracefulMs: 0, forceMs: 0 } as const;

/** A session-owned PTY end that logs each call and its window, failing with `failure`. */
const startupPty = (calls: string[], failure?: unknown): StartupPty => ({
  terminate: (timeouts) => {
    calls.push(`pty.terminate ${timeouts.gracefulMs}/${timeouts.forceMs}`);
    return failure === undefined ? Promise.resolve() : Promise.reject(failure);
  },
});

/** The bridge, watcher, and terminal a live startup holds, each logging its release. */
const liveResources = (calls: string[]) => ({
  bridge: { stop: () => Promise.resolve(void calls.push("bridge.stop")) },
  after: () => calls.push("watcher.stop"),
  terminal: { dispose: () => void calls.push("terminal.dispose") },
});

describe("C-LIFE-10 guarded startup region", () => {
  test("a throwing region tears down every live resource before rethrowing", async () => {
    // A failure AFTER the session is live (e.g. a disk error in the warning flush) must
    // not leak the PTY, bridge, terminal, or watcher.
    const calls: string[] = [];
    await expect(
      guardStartupRegion(() => Promise.reject(new Error("flush failed")), {
        pty: startupPty(calls),
        ...liveResources(calls),
        terminationTimeouts: fastTimeouts,
      }),
    ).rejects.toThrow("flush failed");
    expect(calls).toEqual(["pty.terminate 0/0", "bridge.stop", "watcher.stop", "terminal.dispose"]);
  });

  test("a successful region runs no cleanup", async () => {
    const calls: string[] = [];
    await guardStartupRegion(() => Promise.resolve(), {
      pty: startupPty(calls),
      ...liveResources(calls),
    });
    expect(calls).toEqual([]);
  });
});

describe("cleanupStartupResources", () => {
  test("resolves when no startup resources were created", async () => {
    await expect(cleanupStartupResources({})).resolves.toBeUndefined();
  });

  test("the PTY gets the bounded production termination window unless overridden", async () => {
    const calls: string[] = [];
    await cleanupStartupResources({ pty: startupPty(calls) });
    expect(calls).toEqual(["pty.terminate 5000/1000"]);
  });

  test("C-LIFE-10 runs every step even when the bridge stop rejects", async () => {
    const calls: string[] = [];
    await cleanupStartupResources({
      before: () => calls.push("before"),
      pty: startupPty(calls),
      bridge: { stop: () => Promise.reject(new Error("bridge")) },
      terminal: { dispose: () => calls.push("terminal.dispose") },
      after: () => calls.push("watcher.stop"),
      terminationTimeouts: fastTimeouts,
    });
    expect(calls).toEqual(["before", "pty.terminate 0/0", "watcher.stop", "terminal.dispose"]);
  });

  test("C-LIFE-10 a bridge stop that throws synchronously is contained too", async () => {
    const calls: string[] = [];
    await expect(
      cleanupStartupResources({
        bridge: {
          stop: () => {
            throw new Error("sync bridge failure");
          },
        },
        after: () => calls.push("watcher.stop"),
      }),
    ).resolves.toBeUndefined();
    expect(calls).toEqual(["watcher.stop"]); // later steps still ran
  });

  test("C-LIFE-10 a failed PTY end stays secondary and every later step still runs", async () => {
    // The original startup error must survive: a failed termination or group reap (e.g.
    // EPERM) is contained, and the bridge, watcher, and terminal are still released.
    const calls: string[] = [];
    const failure = Object.assign(new Error("reap failure"), { code: "EPERM" });
    await expect(
      cleanupStartupResources({
        pty: startupPty(calls, failure),
        ...liveResources(calls),
        terminationTimeouts: fastTimeouts,
      }),
    ).resolves.toBeUndefined();
    expect(calls).toEqual(["pty.terminate 0/0", "bridge.stop", "watcher.stop", "terminal.dispose"]);
  });
});
