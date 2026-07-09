/**
 * Codex rendered-screen fact table for turn-state and attention detection.
 * Implements PRD §5.3, C-API-28, C-TURN-01 through C-TURN-05, and C-ATTN-01
 * through C-ATTN-03.
 */

import { hasScreenFact, type ScreenFactRule, type ScreenFactTable } from "../core/screen-facts.ts";
import { trustPromptPatterns } from "../core/trust-prompts.ts";

/**
 * Verified against codex-cli 0.142.5. The working spinner renders
 * "• Working (3s • esc to interrupt)", the interrupt banner renders
 * "■ Conversation interrupted", and the idle composer marker is a
 * line-leading "›". Approval dialogs ask "Would you like to run the following
 * command?" (or an apply-patch variant) with a numbered option list and a
 * "Press enter to confirm or esc to cancel" footer; the dialog also renders a
 * "›" option caret, so the turn watcher's blocking-prompt guard keeps that
 * from reading as an idle composer. The OSC window title carries a
 * braille-spinner glyph (U+2800–U+28FF) while a turn runs and the plain
 * directory name when idle. Verified on codex-cli 0.142.5.
 */
export const codexScreenFactTable: ScreenFactTable = {
  agent: "codex",
  verifiedAgainst: "codex-cli 0.142.5",
  rules: [
    { id: "codex-composer-marker", fact: "composer_visible", all: [/^\s*›/m] },
    { id: "codex-working-spinner", fact: "working_visible", all: [/esc to interrupt/i] },
    {
      id: "codex-working-title",
      fact: "working_visible",
      region: "title",
      all: [/^[⠀-⣿]\s/],
    },
    {
      id: "codex-interrupt-banner",
      fact: "interrupt_complete_visible",
      all: [/Conversation interrupted/],
    },
    {
      id: "codex-approval-dialog",
      fact: "blocking_prompt_visible",
      all: [/Would you like to|Allow command\?/i, /Press enter to confirm or esc to cancel/i],
    },
  ],
};

/** One blocking rule per allowlisted trust prompt (C-ATTN-03). */
const codexTrustRules: readonly ScreenFactRule[] = trustPromptPatterns("codex").map(
  (pattern, index) => ({
    id: `codex-trust-prompt-${index}`,
    fact: "blocking_prompt_visible",
    all: [pattern],
  }),
);

/** With autotrust off, an unanswered trust prompt blocks on the human. */
export function codexScreenFactTableForTrustPolicy(autotrust: boolean): ScreenFactTable {
  if (autotrust) return codexScreenFactTable;
  return { ...codexScreenFactTable, rules: [...codexScreenFactTable.rules, ...codexTrustRules] };
}

/** A quiet boot gap can precede input acceptance; readiness requires this. */
export function codexComposerVisible(text: string): boolean {
  return hasScreenFact(codexScreenFactTable, { text, title: "" }, "composer_visible");
}
