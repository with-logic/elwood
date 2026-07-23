/**
 * Unit coverage for the startup-frame warning helpers (PRD §5.7/§9.1, C-API-14):
 * frame-warning containment, and the buffer-then-live startup gate that keeps
 * pre-return startup warnings observable without late-subscriber replay.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { createStartupWarningGate, deliverFrameWarnings } from "../../src/core/startup-frame.ts";
import type { ElwoodWarningEvent } from "../../src/core/types.ts";

// A COMPLETE, legitimate public warning variant; the per-instance identity travels in a
// valid field (`raw`) so a change to the warning union breaks these tests instead of
// slipping past a structural cast.
const w = (id: string): ElwoodWarningEvent =>
  ({
    elwoodSessionId: "s1",
    agent: "claude",
    source: "lifecycle",
    code: "version_unparseable",
    severity: "warning",
    message: "could not parse version",
    raw: id,
  }) satisfies Extract<ElwoodWarningEvent, { code: "version_unparseable" }>;
/** The per-instance identity each fixture carries in `raw` (never undefined here). */
const ids = (ws: readonly ElwoodWarningEvent[]) => ws.map((x) => x.raw ?? "");

afterEach(() => vi.useRealTimers());

describe("deliverFrameWarnings", () => {
  test("delivers a batch, and CONTAINS a throwing listener (frame continues)", () => {
    const seen: string[] = [];
    deliverFrameWarnings({ emitWarnings: (ws) => seen.push(...ids(ws)) }, [w("a")]);
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
      emitWarnings: (ws) => seen.push(...ids(ws)),
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
      emitWarnings: (ws) => seen.push(...ids(ws)),
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

  test("delivers EVERY observed startup warning — no silent cap (C-API-14)", () => {
    // PRD §5.7/C-API-14 defines no overflow exception: a warning is emitted once when
    // observed. A silent cap could drop the guaranteed `version_unparseable` warning, so
    // the short-lived startup buffer must retain all of them until it drains next macrotask.
    vi.useFakeTimers();
    const seen: string[] = [];
    const gate = createStartupWarningGate({ emitWarnings: (ws) => seen.push(...ids(ws)) });
    for (let i = 0; i < 100; i++) gate.emitWarnings([w(`n${i}`)]);
    gate.openAfterReturn();
    vi.runAllTimers();
    expect(seen).toHaveLength(100); // all delivered, in order
    expect(seen[0]).toBe("n0");
    expect(seen[99]).toBe("n99");
  });
});
