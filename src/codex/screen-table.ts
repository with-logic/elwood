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
 * parameter: production injects a per-session `CodexUpdatePromptTracker`, so the
 * rules that ship are built here, once, rather than rewritten after the fact.
 *
 * That tracker drives TWO lifecycles, which end at different times (C-CODEX-22).
 * Automation eligibility ends as soon as a frame contradicts the appearance, but
 * the INPUT HOLD outlives it: a contradictory replacement is a prompt Elwood may
 * not answer yet a human still owns, so queued input keeps being held until a
 * positively identified composer frame clears it. Do not collapse the two — this
 * rule reports the update prompt, and `withRetainedHoldFallback` reports a hold
 * that outlived its appearance.
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

/**
 * A hold RETAINED after its appearance ended is still blocking, but it is no longer an
 * update prompt — reporting it under `codex-update-prompt` would give consumers update
 * grace and a misleading `blocked_prompt` label for a dialog a human owns (#59 round 3).
 *
 * It is appended LAST, after the trust rules, and is a genuine FALLBACK: it only reports
 * when no more specific rule already identified the frame. A retained hold sitting over a
 * recognized trust gate must surface that gate's own stable id, which `C-ATTN-03`
 * consumers depend on, rather than this generic one.
 */
function withRetainedHoldFallback(
  table: ScreenFactTable,
  retainedHold: () => boolean,
): ScreenFactTable {
  return {
    ...table,
    rules: [
      ...table.rules,
      // `fallback` is the table evaluator's own "only if nothing else set this fact"
      // marker, so ordering LAST plus this flag is all the last-resort semantics needs.
      {
        id: "codex-unidentified-dialog",
        fact: "blocking_prompt_visible",
        fallback: true,
        match: () => retainedHold(),
      },
    ],
  };
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
    // Two rules from one tracker, so blocking and classification stay honest.
    // `observeAndHoldInput` decides whether queued caller/persona input keeps being HELD, and
    // fails safe in the OPPOSITE direction to automation eligibility: a frame Elwood must
    // not write into is still a frame a human owns, so it keeps blocking rather than
    // releasing a paste and Enter into it (C-API-56, C-CODEX-22; #59 round 2). It is
    // called first so the tracker observes each frame exactly once per reading; the
    // update-prompt rule then reports the cached liveness of the CURRENT appearance, and
    // anything still held after that appearance ended reports as an unidentified dialog
    // rather than borrowing the update label (#59 round 3).
    rules: codexScreenFactRules(
      (frame) => updatePrompt.observeAndHoldInput(frame) && updatePrompt.appearanceLive,
    ),
  };
  // The retained-hold fallback is appended AFTER the trust rules so a specific trust id
  // always wins over the generic one (C-ATTN-03).
  return withRetainedHoldFallback(
    withTrustBlockingRules(tracked, "codex", autotrust),
    () => updatePrompt.holdWithoutAppearance,
  );
}
