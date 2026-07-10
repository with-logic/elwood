/**
 * Unit tests for Codex hook-backed initial readiness.
 * Covers PRD §5.3, C-API-19, and C-API-28.
 */

import { describe, expect, test } from "vitest";
import { initialReady } from "../../src/codex/initial-ready.ts";

describe("initialReady", () => {
  test("C-API-28 mark fires readiness once and replays after a session is attached", () => {
    let calls = 0;
    const ready = initialReady(() => calls++);
    // The SessionStart hook path: mark() releases the first queued message.
    ready.mark();
    ready.mark();
    expect(calls).toBe(1);
    ready.replay();
    expect(calls).toBe(2);
  });

  test("C-API-28 the deadline is the fallback when the readiness hook never arrives", async () => {
    let calls = 0;
    const ready = initialReady(() => calls++, 20);
    ready.armDeadline();
    ready.armDeadline();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toBe(1);
  });

  test("C-API-28 a real SessionStart wins over the pending deadline", async () => {
    let calls = 0;
    const ready = initialReady(() => calls++, 100);
    ready.armDeadline();
    ready.mark();
    await new Promise((resolve) => setTimeout(resolve, 150));
    // mark fired once; the later deadline is a no-op because readiness latched.
    expect(calls).toBe(1);
  });

  test("C-API-28 cancel clears the pending starvation deadline", async () => {
    let calls = 0;
    const ready = initialReady(() => calls++, 20);
    ready.armDeadline();
    ready.cancel();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toBe(0);
  });

  test("replay before readiness does nothing", () => {
    let calls = 0;
    const ready = initialReady(() => calls++);
    ready.replay();
    expect(calls).toBe(0);
  });
});
