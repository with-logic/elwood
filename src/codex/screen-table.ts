/**
 * Codex rendered-screen fact table for turn-state and attention detection.
 * Implements PRD §5.3, C-API-28, C-TURN-01 through C-TURN-05, and C-ATTN-01
 * through C-ATTN-03.
 */

import type { ScreenFactRule, ScreenFactTable } from "../core/screen-facts.ts";
import { withTrustBlockingRules } from "../core/trust/blocking.ts";
import type { TrustClearance } from "../core/trust/clearance.ts";
import { codexWorkingScreen, codexWorkingTitle } from "./screen/working.ts";
import { CodexUpdatePromptTracker, codexUpdatePromptVisible } from "./update-prompt.ts";

export { codexComposerClearance as codexTrustClearance } from "./screen/clearance.ts";

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
 * prompt retains its input hold until positive native composer clearance), so the
 * rules that ship are built here, once, rather than rewritten after the fact.
 */
function codexScreenFactRules(updatePromptVisible: (frame: string) => boolean): ScreenFactRule[] {
  return [
    { id: "codex-composer-marker", fact: "composer_visible", all: [/^\s*›/m] },
    { id: "codex-working-spinner", fact: "working_visible", all: [codexWorkingScreen] },
    {
      id: "codex-working-title",
      fact: "working_visible",
      region: "title",
      all: [codexWorkingTitle],
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
export function codexScreenFactTableForTrustPolicy(
  autotrust: boolean,
  clearsInput?: TrustClearance,
): ScreenFactTable {
  const updatePrompt = new CodexUpdatePromptTracker(clearsInput);
  const tracked: ScreenFactTable = {
    agent: "codex",
    verifiedAgainst,
    rules: codexScreenFactRules(updatePrompt.observe.bind(updatePrompt)),
  };
  const table = withTrustBlockingRules(tracked, "codex", autotrust);
  return {
    ...table,
    rules: [
      ...table.rules,
      // Specific approval/trust rules keep their diagnostic identity.
      {
        id: "codex-unidentified-dialog",
        fact: "blocking_prompt_visible",
        fallback: true,
        match: (frame) => updatePrompt.holdWithoutAppearance && !table.trustGateVisible(frame),
      },
    ],
  };
}
