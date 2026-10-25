/**
 * Claude rendered-screen fact table for turn-state and attention detection.
 * Implements PRD §5.3, C-TURN-01 through C-TURN-05, and C-ATTN-01 through
 * C-ATTN-05.
 */

import type { ScreenFactTable } from "../core/screen-facts.ts";
import { withTrustBlockingRules } from "../core/trust/blocking.ts";
import { nativeComposerClearance, type TrustClearance } from "../core/trust/clearance.ts";
import { cursorViewportRow } from "../terminal/coordinates.ts";
import { currentRenderedFrame, settledCursorVisible } from "../terminal/cursor.ts";
import type { ElwoodTerminal } from "../terminal/headless.ts";
import { claudeNamedLabel } from "./composer/border.ts";
import { claudeComposerFooterRow } from "./composer/footer.ts";
import { isClaudeSwitchConfirmation } from "./model-switch-confirmation.ts";
import { claudeQuestionCandidate } from "./questions/screen.ts";

// Claude's working title: a braille spinner, or the half circles 2.1.310 alternates between
// (`◐`, `◑`); the idle title is `✳`. Reading `◑` as idle reported `ready` mid-turn (C-TURN-05).
const claudeWorkingTitle = /^[⠀-⣿◐◑]\s/;
/** Zero-based input position after Claude's two-cell "❯ " composer prefix. */
export const claudeComposerInputColumn = 2;
/** Native empty-composer row shape; callers own activity and dialog checks. */
export const claudeComposerRow = /^\s*❯(?:[ \t ]*|[ \t ]+Try "[^"\n]+")\s*$/m;

/** A composer fenced by rules; a named session labels the top rule (`claudeNamedLabel`). */
const fence = String.raw`(?:^|\n)[─━]{3,}(?:${claudeNamedLabel})?\s*\n❯(?:[ \t ]*|[ \t ]+Try "[^"\n]+")\s*\n[─━]{3,}`;
const fencedComposer = new RegExp(fence);
/** The fence with Claude's footer as the very next row, where transcript text cannot sit. */
const footedComposer = new RegExp(String.raw`${fence}[ \t]*\n${claudeComposerFooterRow}(?:\n|$)`);

/**
 * Claude's trust-clearance grammar, owned HERE beside the rest of Claude's verified
 * screen facts (C-TRUST-01). Clearance needs the composer fenced between rule lines plus
 * Claude's own chrome: its permission-mode footer directly under the fence, or the version
 * banner, which scrolls away in a long session. A frame that merely contains a `❯` is
 * therefore not mistaken for an answered gate.
 */
export const claudeTrustClearance: TrustClearance = nativeComposerClearance(
  claudeComposerRow,
  (frame) =>
    footedComposer.test(frame) || (/Claude Code v[\d.]+/.test(frame) && fencedComposer.test(frame)),
);

/** A per-batch composer cannot release trust until every received byte has rendered. */
export function liveClaudeClearance(
  readTerminal: () => ElwoodTerminal,
  textClearance: TrustClearance = claudeTrustClearance,
): TrustClearance {
  return (text) => {
    const terminal = readTerminal();
    const frame = currentRenderedFrame(terminal);
    if (
      frame?.text !== text ||
      !settledCursorVisible(terminal.xterm) ||
      frame.cursorX !== claudeComposerInputColumn ||
      claudeWorkingTitle.test(terminal.title)
    )
      return false;
    const buffer = terminal.xterm.buffer.active;
    // cursorY is relative to baseY; snapshot row zero starts at viewportY.
    const viewportCursorRow = cursorViewportRow(frame.cursorY, buffer);
    const composer = frame.lines[viewportCursorRow] ?? "";
    return composer.startsWith("❯") && claudeComposerRow.test(composer) && textClearance(text);
  };
}

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
 * on 2.1.258; 2.1.281 also emits the captured "◐ " working prefix
 * — a width-independent working signal that survives Claude's footer elision
 * on narrow screens. Model/effort switch dialogs use either `❯` or `›` and
 * can be numbered or unnumbered; their complete title/action shape blocks the
 * dialog caret from being mistaken for the idle composer. Verified on claude
 * 2.1.258. The questionnaire blocking pattern and manual-mode footer were
 * captured on 2.1.305; other rules retain the earlier version evidence.
 */
export const claudeScreenFactTable: ScreenFactTable = {
  agent: "claude",
  verifiedAgainst:
    "claude 2.1.258; question dialog and manual footer: 2.1.305; working title: 2.1.310",
  rules: [
    {
      id: "claude-question-dialog",
      fact: "blocking_prompt_visible",
      match: claudeQuestionCandidate,
    },
    { id: "claude-composer-marker", fact: "composer_visible", all: [/^\s*❯/m] },
    { id: "claude-working-footer", fact: "working_visible", all: [/esc to interrupt/i] },
    {
      id: "claude-working-title",
      fact: "working_visible",
      region: "title",
      all: [claudeWorkingTitle],
    },
    { id: "claude-interrupt-banner", fact: "interrupt_complete_visible", all: [/⎿\s*Interrupted/] },
    {
      id: "claude-permission-dialog",
      fact: "blocking_prompt_visible",
      all: [/Do you want to [^?]+\?/i, /^\s*(?:❯\s*)?1\.\s*Yes/im, /Esc to cancel/i],
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
