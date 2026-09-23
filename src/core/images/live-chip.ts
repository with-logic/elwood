/** Recovery recognizes only a chip on the live native input surface (PRD §5.3, C-API-44). */

import { currentRenderedFrame, settledCursorVisible } from "../../terminal/cursor.ts";
import type { ElwoodTerminal } from "../../terminal/headless.ts";
import { readScreenFacts, type ScreenFactTable } from "../screen-facts.ts";
import type { TrustClearance } from "../trust/clearance.ts";
import { imageChipCount } from "./chip-wait.ts";

export function liveImageChipCount(
  terminal: ElwoodTerminal,
  clearance: TrustClearance,
  table: ScreenFactTable,
  emptyRow: string,
): number {
  const frame = currentRenderedFrame(terminal);
  if (!(frame && settledCursorVisible(terminal.xterm)) || frame.cursorX < 2) return 0;
  if (readScreenFacts(table, { text: frame.text, title: terminal.title }).facts.working_visible)
    return 0;
  const buffer = terminal.xterm.buffer.active;
  const at = frame.cursorY + buffer.baseY - buffer.viewportY;
  const composer = frame.lines[at];
  if (!(composer && /^[❯›]/.test(composer))) return 0;
  const count = imageChipCount(composer);
  if (count === 0) return 0;
  // Require the adapter's native chrome around this exact cursor row. Only its
  // draft content is removed for that check; transcript and dialog rows remain.
  const rows = [...frame.lines];
  rows[at] = emptyRow;
  return clearance(rows.join("\n")) ? count : 0;
}
