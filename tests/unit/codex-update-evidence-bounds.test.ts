/** Bounded first-party option retention (PRD §5.5, C-CODEX-12). */
import { describe, expect, test } from "vitest";
import {
  bannerContradictsAppearance,
  continuationOptionsAreBound,
  emptyUpdateEvidence,
  retainedOptionLabelsAgree,
  withUpdateFrameEvidence,
} from "../../src/codex/update/evidence.ts";

const bannerFrame = "Update available! 0.1.0 -> 0.2.0\n  1. Update now";
const allSkipPrompt = "  1. Skip backup\n  2. Skip";
describe("C-CODEX-12 appearance evidence is bounded", () => {
  test("C-CODEX-12 a long-lived appearance retains a bounded number of bindings", () => {
    let evidence = emptyUpdateEvidence();
    for (let row = 1; row <= 5_000; row += 1) {
      evidence = withUpdateFrameEvidence(
        evidence,
        `Update available! 0.1.0 -> 0.2.0\n  ${row}. Option ${row}`,
        true,
      );
    }
    expect(evidence.boundOptions.size).toBeLessThanOrEqual(32);
    expect(evidence.overflowed).toBe(true);
  });

  test("C-CODEX-12 an oversized label is dropped rather than retained", () => {
    const evidence = withUpdateFrameEvidence(
      emptyUpdateEvidence(),
      `Update available! 0.1.0 -> 0.2.0\n  1. ${"x".repeat(5_000)}`,
      true,
    );
    expect(evidence.boundOptions.has("1")).toBe(false);
    expect(evidence.overflowed).toBe(true);
  });

  test("C-CODEX-12 an overflowed appearance authorizes nothing", () => {
    let evidence = emptyUpdateEvidence();
    for (let row = 1; row <= 100; row += 1) {
      evidence = withUpdateFrameEvidence(evidence, `  ${row}. Option ${row}`, true);
    }
    expect(retainedOptionLabelsAgree(evidence, "  1. Skip")).toBe(false);
    expect(continuationOptionsAreBound(evidence, "  1. Skip")).toBe(false);
  });
});

describe("C-CODEX-12 appearance evidence", () => {
  test("C-CODEX-12 a frame without first-party evidence vouches for nothing", () => {
    const evidence = withUpdateFrameEvidence(emptyUpdateEvidence(), "  2. Skip", false);
    expect(continuationOptionsAreBound(evidence, "  2. Skip")).toBe(false);
  });

  test("C-CODEX-12 the first label an appearance shows for a number is the one that binds", () => {
    let evidence = withUpdateFrameEvidence(emptyUpdateEvidence(), bannerFrame, true);
    evidence = withUpdateFrameEvidence(evidence, allSkipPrompt, false);
    expect(evidence.boundOptions.get("1")).toBe("Update now");
    expect(continuationOptionsAreBound(evidence, allSkipPrompt)).toBe(false);
  });

  test("C-CODEX-12 an unseen option number lacks continuation provenance", () => {
    const evidence = withUpdateFrameEvidence(emptyUpdateEvidence(), bannerFrame, true);
    expect(continuationOptionsAreBound(evidence, "  2. Skip\n  3. Skip until next version")).toBe(
      false,
    );
  });
});

test("C-CODEX-12 first-party evidence retains immutable first bindings", () => {
  const original = withUpdateFrameEvidence(emptyUpdateEvidence(), bannerFrame, true);
  const extended = withUpdateFrameEvidence(original, `${bannerFrame}\n  2. Skip`, true);
  const relabeled = withUpdateFrameEvidence(extended, "  2. Skip backup", true);
  expect(original.boundOptions.has("2")).toBe(false);
  expect(relabeled.boundOptions.get("2")).toBe("Skip");
  expect(retainedOptionLabelsAgree(extended, "  2. Skip")).toBe(true);
  expect(retainedOptionLabelsAgree(extended, "  3. Skip")).toBe(true);
  expect(retainedOptionLabelsAgree(extended, "  2. Skip backup")).toBe(false);
  expect(continuationOptionsAreBound(extended, "  2. Skip")).toBe(true);
});

test.each([
  "",
  bannerFrame,
  bannerFrame.replace("0.2.0", "0.3.0"),
])("C-CODEX-12 banner contradiction compares only two observed versions: %s", (frame) => {
  expect(bannerContradictsAppearance(emptyUpdateEvidence(), frame)).toBe(false);
  const evidence = withUpdateFrameEvidence(emptyUpdateEvidence(), bannerFrame, true);
  expect(bannerContradictsAppearance(evidence, frame)).toBe(frame.includes("0.3.0"));
});
