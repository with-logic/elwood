/**
 * Clearance is recognized on the composer layouts Codex really renders, and a replaced
 * update screen never reports success. Covers PRD §5.5, C-CODEX-22 and C-CODEX-12.
 */

import { describe, expect, test, vi } from "vitest";
import { CodexStartupPromptResponder } from "../../src/codex/startup-prompts.ts";
import { CodexUpdatePromptTracker } from "../../src/codex/update/index.ts";

const bannerFrame = "Update available! 0.151.0 -> 0.152.0\n  1. Update now";
const allSkipPrompt = "  1. Skip backup\n  2. Skip";

describe("C-CODEX-22 dialog clearance is recognized on real composer layouts", () => {
  const afterReplacement = (frame: string) => {
    const tracker = new CodexUpdatePromptTracker();
    tracker.observeAndHoldInput(bannerFrame);
    tracker.observeAndHoldInput(allSkipPrompt);
    return tracker.observeAndHoldInput(frame);
  };

  test("C-CODEX-22 a real idle composer with its status footer releases the hold", () => {
    // Captured real frames render placeholder text plus a status row, so requiring a BARE
    // caret as the last row would leave queued input blocked for the rest of the session.
    expect(
      afterReplacement("› Ask Codex to do anything\n\n  gpt-6-astra default · /tmp/project"),
    ).toBe(false);
    expect(afterReplacement("› \n\n  ? for shortcuts")).toBe(false);
  });

  test("C-CODEX-22 a half-painted dialog whose caret is bare keeps holding", () => {
    // The dialog's own caret before its options paint. Releasing here would press its
    // highlighted action as soon as the rows arrive.
    expect(afterReplacement("Do you want to proceed?\n› ")).toBe(true);
  });
});

describe("C-CODEX-22 a replaced update screen is never reported as answered", () => {
  test("C-CODEX-22 a contradictory replacement cancels instead of claiming success", async () => {
    vi.useFakeTimers();
    const responder = new CodexStartupPromptResponder("s1");
    let frame = "Update available! 0.151.0 -> 0.152.0\n  1. Update now\n  2. Skip";
    const first = responder.handle(
      frame,
      () => {},
      () => frame,
    );
    frame = allSkipPrompt;
    responder.handle(
      frame,
      () => {},
      () => frame,
    );
    await vi.runAllTimersAsync();
    // Reporting `answered` here would be a FALSE SUCCESS: it cancels the CLI's bounded
    // update grace while the retained hold keeps the session blocked, so a headless run
    // stalls and never emits `blocked_prompt`.
    await expect(first.outcomes[0]?.settled).resolves.toBe("cancelled");
    vi.useRealTimers();
  });

  test("C-CODEX-12 a genuinely cleared screen still settles as answered", async () => {
    vi.useFakeTimers();
    const responder = new CodexStartupPromptResponder("s1");
    let frame = "Update available! 0.151.0 -> 0.152.0\n  1. Update now\n  2. Skip";
    const first = responder.handle(
      frame,
      () => {},
      () => frame,
    );
    frame = "› Ask Codex to do anything\n\n  gpt-6-astra default · /tmp/project";
    responder.handle(
      frame,
      () => {},
      () => frame,
    );
    await vi.runAllTimersAsync();
    await expect(first.outcomes[0]?.settled).resolves.toBe("answered");
    vi.useRealTimers();
  });
});
