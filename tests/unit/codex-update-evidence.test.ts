/**
 * The update-skip key is anchored to an APPEARANCE's own first-party evidence, so an
 * unrelated option-only prompt whose every option is skip-shaped cannot receive it.
 * Covers PRD §5.5 and C-CODEX-22 (issue #50), alongside C-CODEX-12.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { CodexStartupPromptResponder } from "../../src/codex/startup-prompts.ts";
import { CodexUpdatePromptTracker } from "../../src/codex/update/index.ts";

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

  test("C-CODEX-22 an in-flight attempt is CANCELLED by a contradictory replacement", async () => {
    vi.useFakeTimers();
    const responder = new CodexStartupPromptResponder("s1");
    const writes: string[] = [];
    const write = (input: string) => {
      writes.push(input);
    };
    // A COMPLETE screen, so an attempt is genuinely in flight for generation 1.
    let frame = "Update available! 0.151.0 -> 0.152.0\n  1. Update now\n  2. Skip";
    const first = responder.handle(frame, write, () => frame);
    // Swap in a replacement that reassigns `1` and offers its own post-action safe option.
    frame = "  1. Skip backup\n  2. Update now\n  3. Skip";
    responder.handle(frame, write, () => frame);
    await vi.runAllTimersAsync();
    // The ORIGINAL attempt must not settle as answered: its screen was replaced, not
    // cleared, so nothing it wrote can count as having skipped the update.
    await expect(first.outcomes[0]?.settled).resolves.toBe("cancelled");
    // And the captured appearance's digit is never pressed on the replacement.
    expect(writes).not.toContain("1");
  });

  test("C-CODEX-22 a changed version banner starts a new generation", () => {
    const tracker = new CodexUpdatePromptTracker();
    expect(tracker.observe("Update available! 0.151.0 -> 0.152.0\n  1. Update now")).toBe(true);
    const captured = tracker.currentFramePredicate();
    const generation = tracker.currentGeneration;
    // Same options, DIFFERENT version pair: a second appearance, not a repaint of the first.
    const next = "Update available! 0.152.0 -> 0.153.0\n  1. Update now";
    expect(tracker.observe(next)).toBe(true);
    expect(tracker.currentGeneration).not.toBe(generation);
    // The first appearance's pending retry cannot act across the version change.
    expect(captured(next)).toBe(false);
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
