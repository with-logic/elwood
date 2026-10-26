/**
 * Claude's live idle composer, by either verified path (PRD §5.3; C-ATTN-02, C-API-56).
 * The whole-frame path rejects any earlier caret row, and Claude keeps the conversation's
 * own carets in its transcript: each submitted prompt is echoed as `❯ <prompt>`, and
 * `/model` stays as `❯ /model` after the picker closes. So a frame whose transcript still
 * shows one is proved idle by the last composer, its enclosing rules, and its native
 * footer instead. Both paths read the same completed render and its visible input cursor.
 */

import type { TrustClearance } from "../../core/trust/clearance.ts";
import type { ElwoodTerminal } from "../../terminal/headless.ts";
import { liveClaudeClearance } from "../screen-table.ts";
import { claudeLastComposerClearance } from "./last.ts";

export function liveClaudeIdleComposer(readTerminal: () => ElwoodTerminal): TrustClearance {
  const wholeFrame = liveClaudeClearance(readTerminal);
  const lastComposer = liveClaudeClearance(readTerminal, claudeLastComposerClearance);
  return (text) => wholeFrame(text) || lastComposer(text);
}
