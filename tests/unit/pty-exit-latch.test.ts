/**
 * The PTY exit latch behind Codex's `setModel` restore (PRD §5.3, C-CODEX-14): one
 * subscription remembers the exit, because node-pty never replays it to a later
 * subscriber.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { PtyExitLatch } from "../../src/pty/exit-latch.ts";
import type { PtyExit } from "../../src/pty/types.ts";

function fakePty() {
  const handlers = new Set<(exit: PtyExit) => void>();
  return {
    handlers,
    onExit: (handler: (exit: PtyExit) => void) => {
      handlers.add(handler);
      return () => void handlers.delete(handler);
    },
    exit: () => {
      for (const handler of handlers) handler({ exitCode: 0 });
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("C-CODEX-14 PtyExitLatch", () => {
  test("wakes every waiter on exit and answers later waits at once", async () => {
    const pty = fakePty();
    const latch = new PtyExitLatch(pty);
    const waiting = [latch.within(60_000), latch.within(60_000)];
    expect(pty.handlers.size).toBe(1); // one subscription, however many waiters
    pty.exit();
    await expect(Promise.all(waiting)).resolves.toEqual([true, true]);
    await expect(latch.within(0)).resolves.toBe(true);
  });

  test("times out without an exit, and not before its timeout", async () => {
    vi.useFakeTimers();
    const latch = new PtyExitLatch(fakePty());
    let settled: boolean | undefined;
    void latch.within(100).then((exited) => {
      settled = exited;
    });
    await vi.advanceTimersByTimeAsync(99);
    expect(settled).toBeUndefined(); // still waiting 1 ms before the timeout
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(false);
  });
});
