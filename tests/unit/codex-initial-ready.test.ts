/**
 * Unit tests for Codex first terminal-frame readiness replay.
 * Covers PRD §5.3 and C-API-19.
 */

import { describe, expect, test } from "vitest";
import { initialReady } from "../../src/codex/initial-ready.ts";

describe("initialReady", () => {
  test("marks once after quiet delay and replays after a session is attached", async () => {
    let calls = 0;
    const ready = initialReady(() => calls++, 1);
    ready.schedule();
    ready.schedule();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(calls).toBe(1);
    ready.replay();
    expect(calls).toBe(2);
  });

  test("ignores late timer fires after readiness is marked", async () => {
    let calls = 0;
    const ready = initialReady(() => calls++, 1);
    ready.schedule();
    await new Promise((resolve) => setTimeout(resolve, 5));
    ready.schedule();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(calls).toBe(1);
  });

  test("cancels pending readiness", async () => {
    let calls = 0;
    const ready = initialReady(() => calls++, 1);
    ready.schedule();
    ready.cancel();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(calls).toBe(0);
  });
});
