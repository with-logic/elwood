/**
 * Unit coverage for the startup-frame warning helpers (PRD §5.7/§9.1, C-API-14):
 * frame-warning containment, and the buffer-then-live startup gate that keeps
 * pre-return startup warnings observable without late-subscriber replay.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { createStartupWarningGate, deliverFrameWarnings } from "../../src/core/startup-frame.ts";
import type { ElwoodWarningEvent } from "../../src/core/types.ts";

const w = (code: string): ElwoodWarningEvent =>
  ({ code, elwoodSessionId: "s1" }) as unknown as ElwoodWarningEvent;

afterEach(() => vi.useRealTimers());

describe("deliverFrameWarnings", () => {
  test("delivers a batch, and CONTAINS a throwing listener (frame continues)", () => {
    const seen: string[] = [];
    deliverFrameWarnings({ emitWarnings: (ws) => seen.push(...ws.map((x) => x.code)) }, [w("a")]);
    expect(seen).toEqual(["a"]);
    expect(() =>
      deliverFrameWarnings(
        {
          emitWarnings: () => {
            throw new Error("listener boom");
          },
        },
        [w("b")],
      ),
    ).not.toThrow();
  });

  test("no-ops on an absent sink or empty batch", () => {
    let calls = 0;
    const sink = { emitWarnings: () => calls++ };
    deliverFrameWarnings(undefined, [w("a")]);
    deliverFrameWarnings(sink, []);
    expect(calls).toBe(0);
  });
});

describe("createStartupWarningGate", () => {
  test("buffers before open, flushes ALL buffered on the deferred macrotask", () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    const gate = createStartupWarningGate({
      emitWarnings: (ws) => seen.push(...ws.map((x) => x.code)),
    });
    gate.emitWarnings([w("mcp")]);
    gate.emitWarnings([w("version")]);
    expect(seen).toEqual([]); // buffered, not yet delivered
    gate.openAfterReturn();
    expect(seen).toEqual([]); // still nothing until the macrotask runs
    vi.runAllTimers();
    expect(seen).toEqual(["mcp", "version"]); // flushed once, in order
  });

  test("delivers LIVE once open (pass-through)", () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    const gate = createStartupWarningGate({
      emitWarnings: (ws) => seen.push(...ws.map((x) => x.code)),
    });
    gate.openAfterReturn();
    vi.runAllTimers(); // opens with an empty buffer
    expect(seen).toEqual([]);
    gate.emitWarnings([w("live")]); // now a live pass-through
    expect(seen).toEqual(["live"]);
  });

  test("open with NOTHING buffered flushes no batch", () => {
    vi.useFakeTimers();
    let calls = 0;
    const gate = createStartupWarningGate({ emitWarnings: () => calls++ });
    gate.openAfterReturn();
    vi.runAllTimers();
    expect(calls).toBe(0); // empty buffer: the sink is never called
  });

  test("the startup buffer is BOUNDED — excess warnings are dropped", () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    const gate = createStartupWarningGate({
      emitWarnings: (ws) => seen.push(...ws.map((x) => x.code)),
    });
    for (let i = 0; i < 100; i++) gate.emitWarnings([w(`n${i}`)]); // over the 64 ceiling
    gate.openAfterReturn();
    vi.runAllTimers();
    expect(seen).toHaveLength(64); // bounded; kept live-only
    expect(seen[0]).toBe("n0"); // the earliest are retained
  });
});
