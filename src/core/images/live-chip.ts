/** Recovery recognizes only a chip on the live native input surface (PRD §5.3, C-API-44). */

import { currentRenderedFrame, settledCursorVisible } from "../../terminal/cursor.ts";
import type { ElwoodTerminal } from "../../terminal/headless.ts";
import { readScreenFacts, type ScreenFactTable } from "../screen-facts.ts";
import { imageChipCount } from "./chip-wait.ts";

export function liveImageChipCount(
  terminal: ElwoodTerminal,
  emptyRows: (rows: readonly string[], cursorRow: number) => boolean,
  table: ScreenFactTable,
  emptyRow: string,
): number {
  const frame = currentRenderedFrame(terminal);
  if (!(frame && settledCursorVisible(terminal.xterm)) || frame.cursorX < 2) return 0;
  const { facts } = readScreenFacts(table, { text: frame.text, title: terminal.title });
  if (facts.working_visible || facts.blocking_prompt_visible) return 0;
  const buffer = terminal.xterm.buffer.active;
  const at = frame.cursorY + buffer.baseY - buffer.viewportY;
  const composer = frame.lines[at];
  if (!composer?.startsWith(emptyRow.charAt(0))) return 0;
  const count = imageChipCount(composer);
  if (count === 0) return 0;
  // Require the adapter's native chrome around this exact cursor row. Only its
  // draft content is removed for that check; transcript and dialog rows remain.
  const rows = [...frame.lines];
  rows[at] = emptyRow;
  return emptyRows(rows, at) ? count : 0;
}
