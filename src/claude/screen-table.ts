/**
 * Claude rendered-screen fact table for turn-state and attention detection.
 * Implements PRD §5.3, C-TURN-01 through C-TURN-05, and C-ATTN-01 through
 * C-ATTN-03.
 */

import type { ScreenFactRule, ScreenFactTable } from "../core/screen-facts.ts";
import { trustPromptPatterns } from "../core/trust-prompts.ts";

/**
 * Verified against claude 2.1.203 (see `verifiedAgainst`). The footer renders
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
 * on narrow screens. Verified on claude 2.1.203.
 */
export const claudeScreenFactTable: ScreenFactTable = {
  agent: "claude",
  verifiedAgainst: "claude 2.1.203",
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
  ],
};

/** One blocking rule per allowlisted trust prompt (C-ATTN-03). */
const claudeTrustRules: readonly ScreenFactRule[] = trustPromptPatterns("claude").map(
  (pattern, index) => ({
    id: `claude-trust-prompt-${index}`,
    fact: "blocking_prompt_visible",
    all: [pattern],
  }),
);

/** With autotrust off, an unanswered trust prompt blocks on the human. */
export function claudeScreenFactTableForTrustPolicy(autotrust: boolean): ScreenFactTable {
  if (autotrust) return claudeScreenFactTable;
  return { ...claudeScreenFactTable, rules: [...claudeScreenFactTable.rules, ...claudeTrustRules] };
}
