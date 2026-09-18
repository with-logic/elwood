/**
 * Codex rendered-screen fact table for turn-state and attention detection.
 * Implements PRD §5.3, C-API-28, C-TURN-01 through C-TURN-05, and C-ATTN-01
 * through C-ATTN-03.
 */

import type { ScreenFactRule, ScreenFactTable } from "../core/screen-facts.ts";
import { withTrustBlockingRules } from "../core/trust/blocking.ts";
import { CodexUpdatePromptTracker, codexUpdatePromptVisible } from "./update/index.ts";

const verifiedAgainst = "codex-cli 0.142.5";

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
 * directory name when idle. The update-prompt rule takes its matcher as a
 * parameter: production injects a per-session `CodexUpdatePromptTracker` (a split
 * prompt stays blocking until a frame with no update evidence clears it), so the
 * rules that ship are built here, once, rather than rewritten after the fact.
 */
function codexScreenFactRules(updatePromptVisible: (frame: string) => boolean): ScreenFactRule[] {
  return [
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
    { id: "codex-update-prompt", fact: "blocking_prompt_visible", match: updatePromptVisible },
  ];
}

/** The stateless table (single-frame update matcher) for frame-level fact tests. */
export const codexScreenFactTable: ScreenFactTable = {
  agent: "codex",
  verifiedAgainst,
  rules: codexScreenFactRules(codexUpdatePromptVisible),
};

/**
 * The table a session actually runs: a per-session update-prompt tracker plus the
 * shared per-agent trust blocking rules (C-ATTN-03; PRD §5.1). An `always`-answered
 * prompt (hook trust) is auto-handled and never blocks, so `blockingTrustSpecs`
 * already excludes it even when autotrust is off.
 */
export function codexScreenFactTableForTrustPolicy(autotrust: boolean): ScreenFactTable {
  const updatePrompt = new CodexUpdatePromptTracker();
  const tracked: ScreenFactTable = {
    agent: "codex",
    verifiedAgainst,
    // `dialogVisible`, NOT `observe`: this fact decides whether queued caller/persona
    // input keeps being HELD, and that fails safe in the opposite direction to automation
    // eligibility. A frame Elwood must not write into (a replacement dialog contradicting
    // the captured appearance) is still a frame a human owns, so it must keep blocking
    // rather than release a paste and Enter into it (C-API-56, C-CODEX-22; round 2 of #59).
    rules: codexScreenFactRules(updatePrompt.dialogVisible.bind(updatePrompt)),
  };
  return withTrustBlockingRules(tracked, "codex", autotrust);
}
