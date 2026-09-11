/**
 * Unit tests for shared /compact orchestration edges through the public `sessionCompact`
 * entry point, under fake timers. Covers PRD §5.3 and C-API-22.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { sessionCompact } from "../../src/core/compact.ts";
import { writeQueuedInput } from "../../src/core/input/index.ts";
import type { ElwoodSessionStatus } from "../../src/core/types.ts";
import { TypedEmitter } from "../../src/events/emitter.ts";

type CompactEvents = {
  hook: { readonly hook_event_name: string };
  status: { readonly status: ElwoodSessionStatus };
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** A compact run with a recording nudge; `timeoutMs` 80 puts the popup nudge at 40ms. */
function compact(submit: () => Promise<void>, timeoutMs = 80) {
  const emitter = new TypedEmitter<CompactEvents>();
  let nudges = 0;
  const result = sessionCompact(
    emitter,
    submit,
    () => {
      nudges += 1;
    },
    timeoutMs,
  );
  result.catch(() => undefined); // asserted later; a rejection must not surface as unhandled
  return { emitter, result, nudges: () => nudges };
}

describe("sessionCompact", () => {
  test("C-API-22 a failed command submission rejects the compact promise", async () => {
    const run = compact(() => Promise.reject(new Error("boom")));
    await expect(run.result).rejects.toThrow("boom");
    expect(run.nudges()).toBe(0);
  });

  test("C-API-22 an unacknowledged command gets one nudge Enter, then times out", async () => {
    const run = compact(() => Promise.resolve());
    await vi.advanceTimersByTimeAsync(40);
    expect(run.nudges()).toBe(1);
    await vi.advanceTimersByTimeAsync(40);
    await expect(run.result).rejects.toMatchObject({ code: "compact_failed" });
    expect(run.nudges()).toBe(1);
  });

  test("C-API-22 no nudge once PreCompact acknowledges the command", async () => {
    const run = compact(() => Promise.resolve());
    run.emitter.emit("hook", { hook_event_name: "PreCompact" });
    await vi.advanceTimersByTimeAsync(80);
    await expect(run.result).rejects.toMatchObject({ code: "compact_failed" });
    expect(run.nudges()).toBe(0);
  });

  test("C-API-22 PostCompact resolves the compact and cancels the pending nudge", async () => {
    const run = compact(() => Promise.resolve());
    run.emitter.emit("hook", { hook_event_name: "PostCompact" });
    await expect(run.result).resolves.toBeUndefined();
    await vi.runAllTimersAsync();
    expect(run.nudges()).toBe(0);
  });

  test("C-API-22 a terminal status rejects with session_not_running", async () => {
    const run = compact(() => Promise.resolve());
    run.emitter.emit("status", { status: "exited" });
    await expect(run.result).rejects.toMatchObject({ code: "session_not_running" });
  });

  test("C-API-22 a submission resolving AFTER the timeout arms no stray nudge", async () => {
    // The 120s-class timeout can reject while the queued `/compact` write is still pending
    // behind readiness. When that write finally resolves, no nudge may be scheduled: an Enter
    // landing in a session whose compact() already failed would submit whatever is staged.
    let release!: () => void;
    const run = compact(() => new Promise<void>((resolve) => (release = resolve)));
    await vi.advanceTimersByTimeAsync(80);
    await expect(run.result).rejects.toMatchObject({ code: "compact_failed" });
    release();
    await vi.runAllTimersAsync();
    expect(run.nudges()).toBe(0);
  });

  test("C-API-22 the default timeout is 120s with the nudge at 3s", async () => {
    const run = compact(() => Promise.resolve(), undefined);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(run.nudges()).toBe(1);
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(run.result).rejects.toMatchObject({ code: "compact_failed" });
  });

  test("C-API-22 a failed deferred command Enter rejects submission", async () => {
    const writes: string[] = [];
    const terminal = {
      sendInput: (data: string | Uint8Array) => {
        if (data === "\r") throw new Error("terminal disposed");
        writes.push(String(data));
      },
    };
    const submitted = writeQueuedInput(terminal, "/compact", "command");
    submitted.catch(() => undefined);
    await vi.runAllTimersAsync();
    await expect(submitted).rejects.toThrow("terminal disposed");
    expect(writes).toEqual(["/compact"]);
  });
});
