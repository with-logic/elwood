/**
 * Codex rendered-screen fact table for turn-state and attention detection.
 * Implements PRD §5.3, C-API-28, C-TURN-01 through C-TURN-05, and C-ATTN-01
 * through C-ATTN-03.
 */

import type { ScreenFactRule, ScreenFactTable } from "../core/screen-facts.ts";
import { blockingTrustSpecs, trustPromptHeaderVisible } from "../core/trust-prompts.ts";

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

/**
 * A blocking rule per trust prompt that stays UNANSWERED under the policy
 * (C-ATTN-03). An `always`-answered prompt (hook trust) is auto-handled and MUST
 * NOT block, so it is excluded even when autotrust is off. Ids are stable and
 * semantic (from the prompt id), not positional.
 */
export function codexScreenFactTableForTrustPolicy(autotrust: boolean): ScreenFactTable {
  const rules: ScreenFactRule[] = blockingTrustSpecs("codex", autotrust).map((spec) => ({
    id: `codex-${spec.id}-prompt`,
    fact: "blocking_prompt_visible",
    // Option-aware recognition: the header must appear on a NON-option line, so an
    // unrelated dialog whose numbered option merely contains a directory-trust
    // phrase is NOT misclassified as a blocking trust prompt (PRD §5.1). Same
    // recognizer the responder uses, so classification and answering never diverge.
    match: (text) => trustPromptHeaderVisible(text, spec),
  }));
  return rules.length === 0
    ? codexScreenFactTable
    : { ...codexScreenFactTable, rules: [...codexScreenFactTable.rules, ...rules] };
}
