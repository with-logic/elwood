/**
 * Unit coverage for CompletenessOracle (PRD §5.8, C-API-48/53): the text-matching completeness
 * signal and its bounded window — including crossing the documented 1 MiB expected-text cap, so
 * removing the cap would fail this test rather than silently unbound the rolling window.
 */

import { describe, expect, test } from "vitest";
import { CompletenessOracle } from "../../src/core/simple/completeness-oracle.ts";

const EXPECTED_MAX = 1024 * 1024; // must mirror the constant in completeness-oracle.ts

describe("CompletenessOracle", () => {
  test("matches once the collected text contains the expected text", () => {
    const o = new CompletenessOracle();
    expect(o.expectText("DONE")).toBe(true); // non-empty → installs the oracle
    expect(o.hasExpected).toBe(true);
    o.observeText("thinking... ");
    expect(o.matched).toBe(false);
    o.observeText("all DONE now");
    expect(o.matched).toBe(true);
  });

  test("empty / undefined / whitespace expected text clears the oracle (→ quiet settle)", () => {
    const o = new CompletenessOracle();
    expect(o.expectText("   ")).toBe(false); // whitespace trims to empty → not installed
    expect(o.hasExpected).toBe(false);
    expect(o.expectText(undefined)).toBe(false);
    expect(o.matched).toBe(false); // no expected text → never "matched"
  });

  test("crosses the 1 MiB cap: an oversized expected text matches on its capped SUFFIX", () => {
    const o = new CompletenessOracle();
    // Expected text LARGER than EXPECTED_MAX: the oracle keeps only the last EXPECTED_MAX chars.
    const huge = `${"A".repeat(EXPECTED_MAX)}TAIL-MARKER`; // length = EXPECTED_MAX + 11
    o.expectText(huge);
    // The transcript delivers only the capped suffix (the real "final message" tail) — a full
    // 1 MiB+ prefix would never all arrive, but the SUFFIX does and must satisfy the oracle.
    o.observeText(`${"A".repeat(EXPECTED_MAX - 11)}TAIL-MARKER`);
    expect(o.matched).toBe(true); // matched against the capped suffix, bounded window intact
  });

  test("keeps the rolling window bounded across a very long transcript, matching the recent tail", () => {
    const o = new CompletenessOracle();
    o.expectText("FINAL");
    o.observeText("z".repeat(5_000_000)); // 5 MB of noise — must not be retained whole
    expect(o.matched).toBe(false);
    o.observeText("...FINAL");
    expect(o.matched).toBe(true); // the recent tail still contains the expected text
  });
});
