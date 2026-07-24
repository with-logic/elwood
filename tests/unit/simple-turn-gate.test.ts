/**
 * Unit coverage for TurnGate's bounded backing storage (PRD §5.8, C-API-53). The regression:
 * during a CONTINUOUS stream — one event pushed between each consumer `next()` so the queue
 * never momentarily empties — consumed events must still be freed, not retained forever.
 */

import { describe, expect, test } from "vitest";
import { TurnGate } from "../../src/core/simple/turn-gate.ts";

function textEvent(i: number) {
  return { type: "text", text: `e${i}` } as const;
}

describe("TurnGate bounded storage (C-API-53)", () => {
  test("a continuous push-then-consume stream keeps the backing array bounded", async () => {
    const gate = new TurnGate(50, 5_000);
    const iterator = gate.drain();
    let maxBacking = 0;
    // Prime one event so the first `next()` yields immediately, then keep exactly one event
    // in flight: push the NEXT before consuming the current, so `head < length` never lets the
    // "fully caught up" reset run. Only the amortised in-loop compaction can free consumed events.
    gate.push(textEvent(0));
    for (let i = 1; i <= 5000; i += 1) {
      gate.push(textEvent(i)); // a new event arrives before we consume the prior one
      const { value } = await iterator.next();
      expect(value).toEqual(textEvent(i - 1)); // events still arrive in order, none lost
      maxBacking = Math.max(maxBacking, gate.backingSize);
    }
    // Without compaction the backing array would be ~5000 (every consumed event retained). With
    // the amortised prefix compaction it stays a small multiple of the in-flight depth (~1).
    expect(maxBacking).toBeLessThan(200);
  });

  test("the byte cap reports a BYTE overflow distinctly from a count overflow", async () => {
    const gate = new TurnGate(50, 5_000, 1000, 8); // tiny byte cap
    gate.push({ type: "text", text: "0123456789" }); // 10 bytes > 8 → byte overflow
    await expect(gate.done()).rejects.toMatchObject({ code: "wait_timeout" });
    // The recorded error message names bytes, not events.
    const gen = gate.drain();
    await expect(gen.next()).rejects.toThrow(/too many unconsumed bytes/);
  });
});
