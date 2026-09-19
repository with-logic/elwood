/**
 * Input blocking is a SEPARATE fact from automation eligibility, and fails safe in the
 * opposite direction: a dialog Elwood may not answer must keep holding queued input.
 * Covers PRD §5.5 and C-CODEX-22 (issue #50).
 */

import { describe, expect, test } from "vitest";
import { codexScreenFactTableForTrustPolicy } from "../../src/codex/screen-table.ts";
import {
  appearanceBindingsHold,
  emptyUpdateEvidence,
  evidenceAllowsContinuation,
  withUpdateFrameEvidence,
} from "../../src/codex/update/evidence.ts";
import { CodexUpdatePromptTracker, safeUpdateOption } from "../../src/codex/update/index.ts";
import { readScreenFacts } from "../../src/core/screen-facts.ts";

const bannerFrame = "Update available! 0.151.0 -> 0.152.0\n  1. Update now";
const allSkipPrompt = "  1. Skip backup\n  2. Skip";

describe("C-CODEX-22 input blocking is separate from automation eligibility", () => {
  test("C-CODEX-22 a contradicted appearance stops automation but keeps holding input", () => {
    const tracker = new CodexUpdatePromptTracker();
    expect(tracker.observeAndHoldInput(bannerFrame)).toBe(true);
    // Automation must fail CLOSED: the digit was chosen for a different dialog.
    expect(tracker.observe(allSkipPrompt)).toBe(false);
    // The hold must ALSO fail closed: a prompt we may not answer is still a prompt.
    expect(tracker.observeAndHoldInput(allSkipPrompt)).toBe(true);
  });

  test("C-CODEX-22 only a frame with no dialog releases the hold", () => {
    const tracker = new CodexUpdatePromptTracker();
    tracker.observeAndHoldInput(bannerFrame);
    expect(tracker.observeAndHoldInput(allSkipPrompt)).toBe(true);
    // A positive clearance — the composer, no options at all — drops it.
    expect(tracker.observeAndHoldInput("› ")).toBe(false);
  });

  test("C-CODEX-22 a hold is never STARTED for a dialog Elwood did not recognize", () => {
    const tracker = new CodexUpdatePromptTracker();
    // No update appearance was ever recognized, so an unrelated prompt does not block.
    expect(tracker.observeAndHoldInput(allSkipPrompt)).toBe(false);
  });

  test("C-CODEX-22 a CURSOR-style human prompt keeps holding queued input", () => {
    const tracker = new CodexUpdatePromptTracker();
    tracker.observeAndHoldInput(bannerFrame);
    // A cursor-style dialog renders no numbered rows at all. Releasing here would paste
    // and press Enter into it, activating its highlighted action.
    expect(tracker.observeAndHoldInput("Proceed?\n❯ Yes, go ahead\n  No, cancel")).toBe(true);
  });

  test("C-CODEX-22 numbered TRANSCRIPT prose above a composer releases the hold", () => {
    const tracker = new CodexUpdatePromptTracker();
    tracker.observeAndHoldInput(bannerFrame);
    expect(tracker.observeAndHoldInput(allSkipPrompt)).toBe(true);
    // Ordinary agent prose can contain a numbered list. What distinguishes it from a
    // dialog is POSITION: a live composer below the rows means nothing awaits an answer,
    // since both CLIs replace the composer with a dialog. Holding here would pin queued
    // input open for the rest of the session.
    expect(tracker.observeAndHoldInput("● Plan:\n  1. First step\n  2. Second step\n\n› ")).toBe(
      false,
    );
  });
});

describe("C-CODEX-22 a retained hold is classified separately from the update prompt", () => {
  test("C-CODEX-22 a contradicted dialog blocks WITHOUT claiming to be an update prompt", () => {
    const table = codexScreenFactTableForTrustPolicy(false);
    const read = (text: string) => readScreenFacts(table, { text, title: "" });
    expect(read(bannerFrame).facts.blocking_prompt_visible).toBe(true);
    const blocked = read(allSkipPrompt);
    // Still blocking — a human owns this prompt...
    expect(blocked.facts.blocking_prompt_visible).toBe(true);
    // ...but it must NOT be reported as the update prompt, or consumers get update grace
    // and a misleading `blocked_prompt` label for a dialog Elwood never recognized.
    const ids = blocked.matched.map((rule) => rule.id);
    expect(ids).not.toContain("codex-update-prompt");
    expect(ids).toContain("codex-unidentified-dialog");
  });

  test("C-ATTN-03 a retained hold never masks a specific trust rule id", () => {
    const table = codexScreenFactTableForTrustPolicy(false);
    const read = (text: string) => readScreenFacts(table, { text, title: "" });
    read(bannerFrame);
    // A recognized trust gate painted while a hold is retained must still surface its OWN
    // stable id; the generic fallback only reports when nothing more specific matched.
    const gate = read(
      "> You are in /tmp/project\nDo you trust the contents of this directory?\n› 1. Yes, continue\n  2. No, quit\n\n  Press enter to continue",
    );
    const ids = gate.matched.map((rule) => rule.id);
    expect(ids).toContain("codex-workspace_trust-prompt");
    expect(ids).not.toContain("codex-unidentified-dialog");
  });
});

describe("C-CODEX-22 appearance evidence is bounded", () => {
  test("C-CODEX-22 a long-lived appearance retains a bounded number of bindings", () => {
    let evidence = emptyUpdateEvidence();
    // One appearance can span many frames of a long-lived session. Without a bound the
    // retained map grows with every new option number the session ever renders.
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
    // Bindings were dropped, so a relabeled option could no longer be detected. Incomplete
    // evidence must therefore vouch for nothing rather than vouch on what it happens to
    // still remember.
    expect(appearanceBindingsHold(evidence, "  1. Skip")).toBe(false);
    expect(evidenceAllowsContinuation(evidence, "  1. Skip")).toBe(false);
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
    expect(evidenceAllowsContinuation(evidence, "  2. Skip")).toBe(false);
  });

  test("C-CODEX-22 the first label an appearance shows for a number is the one that binds", () => {
    let evidence = withUpdateFrameEvidence(emptyUpdateEvidence(), bannerFrame, true);
    // A contradicting frame cannot rewrite the appearance's history to justify itself.
    evidence = withUpdateFrameEvidence(evidence, allSkipPrompt, false);
    expect(evidence.options.get("1")).toBe("Update now");
    expect(evidenceAllowsContinuation(evidence, allSkipPrompt)).toBe(false);
  });

  test("C-CODEX-22 an unseen option number is not a contradiction", () => {
    const evidence = withUpdateFrameEvidence(emptyUpdateEvidence(), bannerFrame, true);
    expect(evidenceAllowsContinuation(evidence, "  2. Skip\n  3. Skip until next version")).toBe(
      true,
    );
  });
});
