/**
 * Unit coverage for the guarded startup region (PRD §9.1/§9.4, C-LIFE-10): a
 * failure AFTER the session's live resources exist tears every one of them down
 * before rethrowing, so a rejected startup never leaks a PTY, bridge, terminal,
 * or watcher. The PTY here is an injected fake — no real signal is issued.
 */

import { describe, expect, test } from "vitest";
import { guardStartupRegion } from "../../src/runtime/startup-cleanup.ts";

const fakePty = (killed: string[]) => ({
  pid: 1,
  onData: () => () => {},
  onExit: () => () => {},
  write: () => {},
  resize: () => "resized" as const,
  kill: (signal = "SIGTERM") => void killed.push(signal),
});

describe("C-LIFE-10 guarded startup region", () => {
  test("a throwing region tears down every live resource before rethrowing", async () => {
    // The BLOCKER contract: a failure AFTER the session is live (e.g. a disk error in
    // the warning flush) must not leak the PTY, bridge, terminal, or watcher — the
    // region kills the pty, stops the bridge, disposes the terminal, and runs `after`.
    const killed: string[] = [];
    const calls: string[] = [];
    const region = () => Promise.reject(new Error("flush failed"));
    await expect(
      guardStartupRegion(region, {
        pty: fakePty(killed),
        bridge: { stop: () => Promise.resolve(void calls.push("bridge.stop")) },
        terminal: { dispose: () => void calls.push("terminal.dispose") },
        after: () => calls.push("watcher.stop"),
      }),
    ).rejects.toThrow("flush failed");
    expect(killed).toEqual(["SIGTERM"]); // the now-live PTY was signaled, not leaked
    expect(calls).toEqual(["bridge.stop", "watcher.stop", "terminal.dispose"]);
  });

  test("a successful region runs no cleanup", async () => {
    const killed: string[] = [];
    const calls: string[] = [];
    await guardStartupRegion(() => Promise.resolve(), {
      pty: fakePty(killed),
      bridge: { stop: () => Promise.resolve(void calls.push("bridge.stop")) },
      after: () => calls.push("watcher.stop"),
    });
    expect(killed).toEqual([]);
    expect(calls).toEqual([]);
  });
});
