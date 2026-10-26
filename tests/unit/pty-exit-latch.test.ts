/**
 * The PTY exit latch behind termination (PRD §9.4, C-LIFE-10) and Codex's `setModel`
 * restore (PRD §5.3, C-CODEX-14): one subscription remembers the exit, because
 * node-pty never replays it to a later subscriber.
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
  vi.restoreAllMocks();
});

describe("C-LIFE-10 C-CODEX-14 PtyExitLatch", () => {
  test("wakes every waiter on exit and answers later waits at once", async () => {
    const pty = fakePty();
    const latch = new PtyExitLatch(pty);
    const waiting = [latch.within(60_000), latch.within(60_000)];
    expect(pty.handlers.size).toBe(1); // one subscription, however many waiters
    expect(latch.exited).toBe(false);
    pty.exit();
    await expect(Promise.all(waiting)).resolves.toEqual([true, true]);
    expect(latch.exited).toBe(true);
    await expect(latch.within(0)).resolves.toBe(true);
  });

  test("times out without an exit, not before its timeout, held open or not", async () => {
    vi.useFakeTimers();
    const latch = new PtyExitLatch(fakePty());
    const settled: (boolean | undefined)[] = [undefined, undefined];
    void latch.within(100).then((exited) => {
      settled[0] = exited;
    });
    void latch.within(100, { unref: true }).then((exited) => {
      settled[1] = exited;
    });
    await vi.advanceTimersByTimeAsync(99);
    expect(settled).toEqual([undefined, undefined]); // still waiting 1 ms before the timeout
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toEqual([false, false]);
  });

  test("a wait holds the host open unless it asks for unref", async () => {
    // Termination's wait must keep the host alive until the leader is reaped; Codex's
    // restore wait must not keep an otherwise finished host running for five seconds.
    const timers = vi.spyOn(globalThis, "setTimeout");
    const pty = fakePty();
    const latch = new PtyExitLatch(pty);
    const waiting = [latch.within(60_000), latch.within(60_000, { unref: true })];
    const [held, unrefed] = timers.mock.results.map((result) => result.value as NodeJS.Timeout);
    expect([held?.hasRef(), unrefed?.hasRef()]).toEqual([true, false]);
    pty.exit();
    await expect(Promise.all(waiting)).resolves.toEqual([true, true]);
  });

  test("dispose drops the one subscription", () => {
    const pty = fakePty();
    const latch = new PtyExitLatch(pty);
    latch.dispose();
    expect(pty.handlers.size).toBe(0);
  });
});
