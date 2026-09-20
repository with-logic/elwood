/** Bounded first-party option retention (PRD §5.5, C-CODEX-22). */
import { describe, expect, test } from "vitest";
import {
  appearanceBindingsHold,
  emptyUpdateEvidence,
  evidenceAllowsContinuation,
  withUpdateFrameEvidence,
} from "../../src/codex/update/evidence.ts";

const bannerFrame = "Update available! 0.1.0 -> 0.2.0\n  1. Update now";
const allSkipPrompt = "  1. Skip backup\n  2. Skip";
describe("C-CODEX-22 appearance evidence is bounded", () => {
  test("C-CODEX-22 a long-lived appearance retains a bounded number of bindings", () => {
    let evidence = emptyUpdateEvidence();
    for (let row = 1; row <= 5_000; row += 1) {
      evidence = withUpdateFrameEvidence(
        evidence,
        `Update available! 0.1.0 -> 0.2.0\n  ${row}. Option ${row}`,
        true,
      );
    }
    expect(evidence.options.size).toBeLessThanOrEqual(32);
    expect(evidence.overflowed).toBe(true);
  });

  test("C-CODEX-22 an oversized label is dropped rather than retained", () => {
    const evidence = withUpdateFrameEvidence(
      emptyUpdateEvidence(),
      `Update available! 0.1.0 -> 0.2.0\n  1. ${"x".repeat(5_000)}`,
      true,
    );
    expect(evidence.options.has("1")).toBe(false);
    expect(evidence.overflowed).toBe(true);
  });

  test("C-CODEX-22 an overflowed appearance authorizes nothing", () => {
    let evidence = emptyUpdateEvidence();
    for (let row = 1; row <= 100; row += 1) {
      evidence = withUpdateFrameEvidence(evidence, `  ${row}. Option ${row}`, true);
    }
    expect(appearanceBindingsHold(evidence, "  1. Skip")).toBe(false);
    expect(evidenceAllowsContinuation(evidence, "  1. Skip")).toBe(false);
  });
});

describe("C-CODEX-22 appearance evidence", () => {
  test("C-CODEX-22 a frame without first-party evidence vouches for nothing", () => {
    const evidence = withUpdateFrameEvidence(emptyUpdateEvidence(), "  2. Skip", false);
    expect(evidenceAllowsContinuation(evidence, "  2. Skip")).toBe(false);
  });

  test("C-CODEX-22 the first label an appearance shows for a number is the one that binds", () => {
    let evidence = withUpdateFrameEvidence(emptyUpdateEvidence(), bannerFrame, true);
    evidence = withUpdateFrameEvidence(evidence, allSkipPrompt, false);
    expect(evidence.options.get("1")).toBe("Update now");
    expect(evidenceAllowsContinuation(evidence, allSkipPrompt)).toBe(false);
  });

  test("C-CODEX-22 an unseen option number lacks continuation provenance", () => {
    const evidence = withUpdateFrameEvidence(emptyUpdateEvidence(), bannerFrame, true);
    expect(evidenceAllowsContinuation(evidence, "  2. Skip\n  3. Skip until next version")).toBe(
      false,
    );
  });
});
