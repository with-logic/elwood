/**
 * Unit tests for shared compact orchestration edges.
 * Covers PRD §5.3 and C-API-22.
 */

import { describe, expect, test } from "vitest";
import { runCompact } from "../../src/core/compact.ts";
import { writeQueuedInput } from "../../src/core/session-input.ts";

describe("runCompact", () => {
  test("C-API-22 a failed command submission rejects the compact promise", async () => {
    const result = runCompact({
      submit: () => Promise.reject(new Error("boom")),
      nudge: () => {},
      onHookName: () => () => {},
      onStatus: () => () => {},
      timeoutMs: 1_000,
      nudgeDelayMs: 1_000,
    });
    await expect(result).rejects.toThrow("boom");
  });

  test("C-API-22 an unacknowledged command gets one nudge Enter", async () => {
    let nudges = 0;
    const result = runCompact({
      submit: () => Promise.resolve(),
      nudge: () => {
        nudges += 1;
      },
      onHookName: () => () => {},
      onStatus: () => () => {},
      timeoutMs: 80,
      nudgeDelayMs: 10,
    });
    await expect(result).rejects.toMatchObject({ code: "compact_failed" });
    expect(nudges).toBe(1);
  });

  test("C-API-22 no nudge once PreCompact acknowledges the command", async () => {
    let nudges = 0;
    let hookHandler: (name: string) => void = () => {};
    const result = runCompact({
      submit: () => Promise.resolve(),
      nudge: () => {
        nudges += 1;
      },
      onHookName: (handler) => {
        hookHandler = handler;
        return () => {};
      },
      onStatus: () => () => {},
      timeoutMs: 80,
      nudgeDelayMs: 10,
    });
    hookHandler("PreCompact");
    await expect(result).rejects.toMatchObject({ code: "compact_failed" });
    expect(nudges).toBe(0);
  });

  test("C-API-22 a deferred Enter on a terminated session is swallowed", async () => {
    const writes: string[] = [];
    const terminal = {
      sendInput: (data: string | Uint8Array) => {
        if (data === "\r") throw new Error("terminal disposed");
        writes.push(String(data));
      },
    };
    writeQueuedInput(terminal, "/compact", "command", undefined, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(writes).toEqual(["/compact"]);
  });
});
