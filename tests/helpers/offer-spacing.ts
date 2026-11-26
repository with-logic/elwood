/**
 * Fake timers at the auto-mode offer decline's real spacing, so a test can act between two
 * attempts (PRD §5.1, C-CLAUDE-27).
 */
import { onTestFinished, vi } from "vitest";
import { offerDeclineSpacingMs } from "../../src/claude/auto-mode/decline.ts";

/** Installs fake timers for the rest of the test and returns the spacing between attempts. */
export function fakeOfferSpacing(): number {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  return offerDeclineSpacingMs;
}
