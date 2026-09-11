/**
 * Coverage for CleanupLatch (PRD §9.4): concurrent callers coalesce onto one
 * attempt, a FAILED attempt clears the cache so the next call retries, and the
 * float() path owns a rejection instead of leaking it as an unhandled rejection.
 */

import { describe, expect, test, vi } from "vitest";
import { CleanupLatch } from "../../src/runtime/shutdown/cleanup-latch.ts";

describe("CleanupLatch (§9.4)", () => {
  test("§9.4 coalesces concurrent callers onto a single in-flight attempt", async () => {
    const run = vi.fn(() => Promise.resolve());
    const latch = new CleanupLatch(run);
    const a = latch.attempt();
    const b = latch.attempt();
    expect(a).toBe(b); // same in-flight promise
    await Promise.all([a, b]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  test("§9.4 a FAILED attempt clears the cache so the next call retries", async () => {
    let calls = 0;
    const latch = new CleanupLatch(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error("boom")) : Promise.resolve();
    });
    await expect(latch.attempt()).rejects.toThrow(/boom/);
    // The rejection propagated to the first caller; a later call re-runs cleanup.
    await expect(latch.attempt()).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });

  test("§9.4 a succeeded attempt stays cached (no redundant re-run)", async () => {
    const run = vi.fn(() => Promise.resolve());
    const latch = new CleanupLatch(run);
    await latch.attempt();
    await latch.attempt();
    expect(run).toHaveBeenCalledTimes(1);
  });

  test("§9.4 a deferred rejection clears the cache so a fresh attempt runs", async () => {
    // The first attempt settles as a rejection only later; once it does, the cache
    // is cleared and the next attempt is a genuinely new run (not the old failure).
    let rejectFirst: (e: Error) => void = () => undefined;
    let call = 0;
    const latch = new CleanupLatch(() => {
      call += 1;
      if (call === 1) return new Promise<void>((_res, rej) => (rejectFirst = rej));
      return Promise.resolve();
    });
    const first = latch.attempt();
    rejectFirst(new Error("late"));
    await expect(first).rejects.toThrow(/late/);
    await expect(latch.attempt()).resolves.toBeUndefined();
    expect(call).toBe(2);
  });

  test("§9.4 float() owns a rejection so it never becomes an unhandled rejection", async () => {
    const latch = new CleanupLatch(() => Promise.reject(new Error("floated")));
    // Must not throw synchronously and must not produce an unhandled rejection.
    expect(() => latch.float()).not.toThrow();
    // A subsequent explicit attempt still surfaces the (retried) failure to a caller.
    await expect(latch.attempt()).rejects.toThrow(/floated/);
  });
});
