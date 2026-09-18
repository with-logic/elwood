/**
 * The update-skip key is anchored to an APPEARANCE's own first-party evidence, so an
 * unrelated option-only prompt whose every option is skip-shaped cannot receive it.
 * Covers PRD §5.5 and C-CODEX-22 (issue #50), alongside C-CODEX-12.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { CodexStartupPromptResponder } from "../../src/codex/startup-prompts.ts";
import {
  emptyUpdateEvidence,
  frameContinuesAppearance,
  withUpdateFrameEvidence,
} from "../../src/codex/update-evidence.ts";
import { CodexUpdatePromptTracker, safeUpdateOption } from "../../src/codex/update-prompt.ts";

afterEach(() => vi.useRealTimers());

// The measured real split (#50): the banner frame carries ONLY `1. Update now`, and the
// safe option arrives on a later frame from the accumulated buffer.
const bannerFrame = "Update available! 0.151.0 -> 0.152.0\n  1. Update now";
// The unrelated prompt from #50: option-only, and EVERY option is skip-shaped.
const allSkipPrompt = "  1. Skip backup\n  2. Skip";

describe("C-CODEX-22 update-skip requires the appearance's own first-party evidence", () => {
  test("C-CODEX-22 an all-skip-shaped option-only prompt is not an update continuation", () => {
    const tracker = new CodexUpdatePromptTracker();
    expect(tracker.observe(bannerFrame)).toBe(true);
    // Its option `1` contradicts the `1. Update now` this appearance showed, so it is a
    // DIFFERENT dialog however skip-shaped its rows are.
    expect(tracker.observe(allSkipPrompt)).toBe(false);
  });

  test("C-CODEX-22 no update-skip key reaches an all-skip-shaped unrelated prompt", async () => {
    vi.useFakeTimers();
    const responder = new CodexStartupPromptResponder("s1");
    const writes: string[] = [];
    const write = (input: string) => {
      writes.push(input);
    };
    responder.handle(bannerFrame, write);
    const result = responder.handle(allSkipPrompt, write, () => allSkipPrompt);
    await vi.runAllTimersAsync();
    await Promise.all(result.outcomes.map((outcome) => outcome.settled));
    expect(writes).toEqual([]);
  });

  test("C-CODEX-22 a first-party-SHAPED replacement cannot inherit the appearance", () => {
    const tracker = new CodexUpdatePromptTracker();
    expect(tracker.observe(bannerFrame)).toBe(true);
    const captured = tracker.currentFramePredicate();
    const generation = tracker.currentGeneration;
    // A complete-looking update screen that REASSIGNS the captured `1`. Shape alone would
    // accept it, which would let the running attempt press `1` on a different dialog.
    const replacement = "  1. Skip backup\n  2. Update now";
    // It is still a blocking update screen, but a NEW appearance...
    expect(tracker.observe(replacement)).toBe(true);
    expect(tracker.currentGeneration).not.toBe(generation);
    // ...so the predicate captured on the ORIGINAL appearance no longer authorizes it.
    expect(captured(replacement)).toBe(false);
  });

  test("C-CODEX-22 no update-skip key reaches a first-party-shaped replacement", async () => {
    vi.useFakeTimers();
    const responder = new CodexStartupPromptResponder("s1");
    const writes: string[] = [];
    const write = (input: string) => {
      writes.push(input);
    };
    const replacement = "  1. Skip backup\n  2. Update now";
    responder.handle(bannerFrame, write);
    const result = responder.handle(replacement, write, () => replacement);
    await vi.runAllTimersAsync();
    await Promise.all(result.outcomes.map((outcome) => outcome.settled));
    // `1` is bound to `Update now` on the captured appearance; it must never be pressed
    // on a dialog that reassigned it.
    expect(writes).not.toContain("1");
  });

  test("C-CODEX-12 a genuine banner-less safe-option repaint still continues its appearance", () => {
    const tracker = new CodexUpdatePromptTracker();
    expect(tracker.observe(bannerFrame)).toBe(true);
    // The real continuation: `1` scrolled off, and 2/3 are numbers this appearance had
    // not yet shown. Nothing contradicts the captured evidence.
    expect(tracker.observe("  2. Skip\n  3. Skip until next version")).toBe(true);
  });

  test("C-CODEX-22 a continuation cannot start an appearance on its own", () => {
    const tracker = new CodexUpdatePromptTracker();
    // With no first-party frame ever recognized there is no appearance to continue.
    expect(tracker.observe("  2. Skip\n  3. Skip until next version")).toBe(false);
  });

  test("C-CODEX-22 evidence accumulates across an appearance's frames", () => {
    const tracker = new CodexUpdatePromptTracker();
    tracker.observe(bannerFrame);
    expect(tracker.observe("  2. Skip")).toBe(true);
    // Frame three must be consistent with BOTH earlier frames: `2` was `Skip`, so a
    // prompt relabelling it has replaced the dialog.
    expect(tracker.observe("  2. Skip backup\n  3. Skip")).toBe(false);
  });

  test("C-CODEX-22 a cleared appearance does not lend its evidence to the next frame", () => {
    const tracker = new CodexUpdatePromptTracker();
    tracker.observe(bannerFrame);
    expect(tracker.observe("› ")).toBe(false);
    // The cleared appearance's `firstParty` must not vouch for an unrelated prompt.
    expect(tracker.observe("  2. Skip\n  3. Skip until next version")).toBe(false);
  });
});

describe("C-CODEX-22 safe-option selection respects update-screen layout", () => {
  test("C-CODEX-22 the real layout still yields its safe option", () => {
    expect(safeUpdateOption("  1. Update now\n  2. Skip")?.number).toBe("2");
    expect(
      safeUpdateOption("  1. Update now\n  2. Skip\n  3. Skip until next version")?.number,
    ).toBe("2");
  });

  test("C-CODEX-22 a banner-less continuation is unconstrained by the action ordering", () => {
    // No update action on the frame, so the first safe row is the right one.
    expect(safeUpdateOption("  2. Skip\n  3. Skip until next version")?.number).toBe("2");
  });

  test("C-CODEX-22 a skip-shaped row listed BEFORE the update action is never selected", () => {
    // Selecting `1` here would press `Skip backup` on a dialog that is not the update
    // screen's real layout; there is no safe option after the action, so none is offered.
    expect(safeUpdateOption("  1. Skip backup\n  2. Update now")).toBeUndefined();
  });

  test("C-CODEX-22 the update action itself is never a safe option", () => {
    // `Update now (skip prompts)` matches the safe pattern on "skip" but PERFORMS the update.
    expect(safeUpdateOption("  1. Update now (skip prompts)")).toBeUndefined();
  });
});

describe("C-CODEX-22 appearance evidence", () => {
  test("C-CODEX-22 a frame without first-party evidence vouches for nothing", () => {
    const evidence = withUpdateFrameEvidence(emptyUpdateEvidence(), "  2. Skip", false);
    expect(frameContinuesAppearance(evidence, "  2. Skip")).toBe(false);
  });

  test("C-CODEX-22 the first label an appearance shows for a number is the one that binds", () => {
    let evidence = withUpdateFrameEvidence(emptyUpdateEvidence(), bannerFrame, true);
    // A contradicting frame cannot rewrite the appearance's history to justify itself.
    evidence = withUpdateFrameEvidence(evidence, allSkipPrompt, false);
    expect(evidence.options.get("1")).toBe("Update now");
    expect(frameContinuesAppearance(evidence, allSkipPrompt)).toBe(false);
  });

  test("C-CODEX-22 an unseen option number is not a contradiction", () => {
    const evidence = withUpdateFrameEvidence(emptyUpdateEvidence(), bannerFrame, true);
    expect(frameContinuesAppearance(evidence, "  2. Skip\n  3. Skip until next version")).toBe(
      true,
    );
  });
});
