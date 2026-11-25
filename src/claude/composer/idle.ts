/**
 * Claude's live idle composer, by either verified path (PRD §5.3, §5.4; C-ATTN-02,
 * C-TRUST-01, C-API-56). It is what proves a session's blocking dialog or startup trust
 * gate is gone. The whole-frame path rejects any earlier caret row, and Claude keeps the
 * conversation's own carets in its transcript: each submitted prompt is echoed as
 * `❯ <prompt>`, a resumed session repaints them, and `/model` stays as `❯ /model` after
 * the picker closes. So a frame whose transcript still shows one is proved idle by the
 * last composer, its enclosing rules, and its native footer instead. Both paths read the
 * same completed render and its visible input cursor, which is checked once for both.
 * Attention clearance also accepts it holding staged input that awaits its Enter (C-ATTN-09).
 */

import type { TrustClearance } from "../../core/trust/clearance.ts";
import type { ElwoodTerminal } from "../../terminal/headless.ts";
import { claudeTrustClearance, liveClaudeClearance } from "../screen-table.ts";
import { claudeLastComposerClearance } from "./last.ts";
import { claudeStagedComposerClearance } from "./staged-input.ts";

export function liveClaudeIdleComposer(readTerminal: () => ElwoodTerminal): TrustClearance {
  // One check of the live render and cursor, then either text path.
  return liveClaudeClearance(
    readTerminal,
    (text) => claudeTrustClearance(text) || claudeLastComposerClearance(text),
  );
}

/**
 * What ends a blocking dialog's episode (C-ATTN-02): the idle composer, or, while the
 * session's own staged input still awaits its Enter, the same verified composer holding
 * that draft. A paste written just before Claude's auto-mode offer painted is then
 * submitted by its held Enter once the offer closes (C-ATTN-09). A draft left after the
 * Enter has gone out is not clearance, and trust and readiness keep the idle composer.
 */
export function liveClaudeAttentionClearance(
  idle: TrustClearance,
  readTerminal: () => ElwoodTerminal,
  awaitsSubmission: (terminal: ElwoodTerminal) => boolean,
): TrustClearance {
  const staged = claudeStagedComposerClearance(readTerminal);
  return (text) => idle(text) || (awaitsSubmission(readTerminal()) && staged(text));
}
