/**
 * The real Claude first-launch proof answers the terminal-setup offer with Esc, even beside
 * an earlier screen's text, and never presses a key on a screen it does not know
 * (PRD §5.4, C-E2E-28).
 */
import { expect, test } from "vitest";
import { firstLaunchKey } from "../e2e/claude-first-launch-answers.ts";

const offer =
  " Use Claude Code's terminal setup?\n\n ❯ 1. Yes, use recommended settings\n   2. No\n\n Esc to skip";
const picker = " Choose the text style that looks best with your terminal\n ❯ 1. Dark mode";
const notes = " Security notes:\n\n 1. Claude can make mistakes\n\n Press Enter to continue…";

test.each([
  ["the terminal-setup offer", offer, "\u001b"],
  ["the offer drawn under the text-style picker's text", `${picker}\n${offer}`, "\u001b"],
  ["the offer drawn under the security notes' text", `${notes}\n${offer}`, "\u001b"],
  ["the text-style picker", picker, "\r"],
  ["the security notes", notes, "\r"],
  ["a screen it does not know", " Select login method:\n ❯ 1. Claude account", undefined],
])("C-E2E-28 %s", (_, screen, key) => {
  expect(firstLaunchKey(screen)).toBe(key);
});
