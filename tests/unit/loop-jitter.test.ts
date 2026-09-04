/**
 * Unit coverage for stable, delay-only recurring-loop jitter.
 * Covers PRD §5.9 and C-LOOP-04.
 */

import { describe, expect, test } from "vitest";
import { IDLE_LOOP_INTERVAL_MS, MAX_LOOP_JITTER_MS } from "../../src/core/loops/constants.ts";
import { deriveLoopJitterMs } from "../../src/core/loops/jitter.ts";

describe("deriveLoopJitterMs", () => {
  test("C-LOOP-04 derives stable offsets from the ID alone", () => {
    expect(deriveLoopJitterMs("loop-1", IDLE_LOOP_INTERVAL_MS)).toBe(27_286);
    expect(deriveLoopJitterMs("loop-1", IDLE_LOOP_INTERVAL_MS)).toBe(27_286);
    expect(deriveLoopJitterMs("loop-2", IDLE_LOOP_INTERVAL_MS)).toBe(6_106);
    expect(deriveLoopJitterMs("å-loop", IDLE_LOOP_INTERVAL_MS)).toBe(8_834);
  });

  test("C-LOOP-04 uses ten percent for short cadences and the 30-second cap", () => {
    const short = deriveLoopJitterMs("loop-1", 60_000);
    const capped = deriveLoopJitterMs("loop-1", 600_000);

    expect(short).toBe(613);
    expect(short).toBeGreaterThanOrEqual(0);
    expect(short).toBeLessThanOrEqual(6_000);
    expect(capped).toBeGreaterThanOrEqual(0);
    expect(capped).toBeLessThanOrEqual(MAX_LOOP_JITTER_MS);
  });
});
