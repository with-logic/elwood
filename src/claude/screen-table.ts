/**
 * Claude rendered-screen fact table for turn-state and attention detection.
 * Implements PRD §5.3, C-TURN-01 through C-TURN-05, and C-ATTN-01 through
 * C-ATTN-04.
 */

import type { ScreenFactTable } from "../core/screen-facts.ts";
import { withTrustBlockingRules } from "../core/trust/blocking.ts";
import { isClaudeSwitchConfirmation } from "./model-switch-confirmation.ts";

/**
 * Verified through claude 2.1.258 (see `verifiedAgainst`). The footer renders
 * "... · esc to interrupt · ..." only while a turn runs and is elided below
 * roughly 66 columns, so narrow interrupts are detected by the end banner.
 * The banner renders "⎿  Interrupted· What should Claude do"; the ⎿ chrome
 * prefix keeps model output that echoes "Interrupted" from matching. The
 * idle composer marker is a line-leading "❯". Permission dialogs ask
 * "Do you want to <action>?" (e.g. "create elwood.txt", "proceed") followed
 * by a numbered "❯ 1. Yes" / "3. No" list and an "Esc to cancel" footer;
 * matching the question plus the numbered-Yes line together avoids matching
 * model prose that merely quotes the phrase. The OSC window title carries a
 * braille-spinner glyph (U+2800–U+28FF) while a turn runs and "✳ " when idle
 * — a width-independent working signal that survives Claude's footer elision
 * on narrow screens. Model/effort switch dialogs use either `❯` or `›` and
 * can be numbered or unnumbered; their complete title/action shape blocks the
 * dialog caret from being mistaken for the idle composer. Verified on claude
 * 2.1.258.
 */
export const claudeScreenFactTable: ScreenFactTable = {
  agent: "claude",
  verifiedAgainst: "claude 2.1.258",
  rules: [
    { id: "claude-composer-marker", fact: "composer_visible", all: [/^\s*❯/m] },
    { id: "claude-working-footer", fact: "working_visible", all: [/esc to interrupt/i] },
    {
      id: "claude-working-title",
      fact: "working_visible",
      region: "title",
      all: [/^[⠀-⣿]\s/],
    },
    { id: "claude-interrupt-banner", fact: "interrupt_complete_visible", all: [/⎿\s*Interrupted/] },
    {
      id: "claude-permission-dialog",
      fact: "blocking_prompt_visible",
      all: [/Do you want to .+\?/i, /^\s*❯\s*1\.\s*Yes/im, /Esc to cancel/i],
    },
    {
      id: "claude-model-switch-confirmation",
      fact: "blocking_prompt_visible",
      match: isClaudeSwitchConfirmation,
    },
  ],
};

/** Appends the shared per-agent trust blocking rules (C-ATTN-03; PRD §5.1). */
export function claudeScreenFactTableForTrustPolicy(autotrust: boolean): ScreenFactTable {
  return withTrustBlockingRules(claudeScreenFactTable, "claude", autotrust);
}
