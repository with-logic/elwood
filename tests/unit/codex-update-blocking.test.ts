/**
 * Input blocking is a SEPARATE fact from automation eligibility, and fails safe in the
 * opposite direction: a dialog Elwood may not answer must keep holding queued input.
 * Covers PRD §5.5 and C-CODEX-22 (issue #50).
 */

import { describe, expect, test } from "vitest";
import { codexScreenFactTableForTrustPolicy } from "../../src/codex/screen-table.ts";
import {
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
    expect(tracker.dialogVisible(bannerFrame)).toBe(true);
    // Automation must fail CLOSED: the digit was chosen for a different dialog.
    expect(tracker.observe(allSkipPrompt)).toBe(false);
    // The hold must ALSO fail closed: a prompt we may not answer is still a prompt.
    expect(tracker.dialogVisible(allSkipPrompt)).toBe(true);
  });

  test("C-CODEX-22 only a frame with no dialog releases the hold", () => {
    const tracker = new CodexUpdatePromptTracker();
    tracker.dialogVisible(bannerFrame);
    expect(tracker.dialogVisible(allSkipPrompt)).toBe(true);
    // A positive clearance — the composer, no options at all — drops it.
    expect(tracker.dialogVisible("› ")).toBe(false);
  });

  test("C-CODEX-22 a hold is never STARTED for a dialog Elwood did not recognize", () => {
    const tracker = new CodexUpdatePromptTracker();
    // No update appearance was ever recognized, so an unrelated prompt does not block.
    expect(tracker.dialogVisible(allSkipPrompt)).toBe(false);
  });

  test("C-CODEX-22 a CURSOR-style human prompt keeps holding queued input", () => {
    const tracker = new CodexUpdatePromptTracker();
    tracker.dialogVisible(bannerFrame);
    // A cursor-style dialog renders no numbered rows at all. Releasing here would paste
    // and press Enter into it, activating its highlighted action.
    expect(tracker.dialogVisible("Proceed?\n❯ Yes, go ahead\n  No, cancel")).toBe(true);
  });

  test("C-CODEX-22 numbered TRANSCRIPT prose above a composer releases the hold", () => {
    const tracker = new CodexUpdatePromptTracker();
    tracker.dialogVisible(bannerFrame);
    expect(tracker.dialogVisible(allSkipPrompt)).toBe(true);
    // Ordinary agent prose can contain a numbered list. What distinguishes it from a
    // dialog is POSITION: a live composer below the rows means nothing awaits an answer,
    // since both CLIs replace the composer with a dialog. Holding here would pin queued
    // input open for the rest of the session.
    expect(tracker.dialogVisible("● Plan:\n  1. First step\n  2. Second step\n\n› ")).toBe(false);
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
