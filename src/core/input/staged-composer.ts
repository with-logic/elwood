/** Read only a live idle native draft, excluding submitted history (PRD §5.3, C-API-31). */
import { currentRenderedFrame, settledCursorVisible } from "../../terminal/cursor.ts";
import type { ElwoodTerminal } from "../../terminal/headless.ts";
import { readScreenFacts, type ScreenFactTable } from "../screen-facts.ts";

export function readStagedComposer(
  terminal: ElwoodTerminal,
  matchesEmptyInput: (rows: readonly string[], viewportCursorRow: number) => boolean,
  table: ScreenFactTable,
  emptyRow: string,
): string | undefined {
  const frame = currentRenderedFrame(terminal);
  // The native caret prefix occupies two cells; content advances the actual cursor.
  if (!(frame && settledCursorVisible(terminal.xterm)) || frame.cursorX < 2) return undefined;
  const { facts } = readScreenFacts(table, { text: frame.text, title: terminal.title });
  if (facts.working_visible || facts.blocking_prompt_visible) return undefined;
  const buffer = terminal.xterm.buffer.active;
  const viewportCursorRow = frame.cursorY + buffer.baseY - buffer.viewportY;
  if (viewportCursorRow >= frame.lines.length) return undefined;
  // Placeholder-shaped input remains ambiguous even with a stale advanced cursor.
  if (matchesEmptyInput(frame.lines, viewportCursorRow)) return undefined;
  const rows = frame.lines.slice(0, viewportCursorRow + 1);
  const start = rows.findLastIndex(
    (row) => row.startsWith(emptyRow.charAt(0)) && /^[ \u00a0]$/.test(row.charAt(1)),
  );
  if (start < 0 || !rows.slice(start + 1).every((row) => row.startsWith("  "))) return undefined;
  // A wrapped/multiline Codex draft continues with two-space indentation. Replace
  // only the cursor-owned draft region; transcript and unknown overlays remain.
  const normalized = [
    ...frame.lines.slice(0, start),
    emptyRow,
    ...frame.lines.slice(viewportCursorRow + 1),
  ];
  return matchesEmptyInput(normalized, start) ? rows.slice(start).join("\n") : undefined;
}
