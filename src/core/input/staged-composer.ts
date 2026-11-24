/** Read only a live idle native draft, excluding submitted history (PRD §5.3, C-API-31). */
import { currentRenderedFrame, settledCursorVisible } from "../../terminal/cursor.ts";
import type { ElwoodTerminal } from "../../terminal/headless.ts";
import { readScreenFacts, type ScreenFactTable } from "../screen-facts.ts";

export function readStagedComposer(
  terminal: ElwoodTerminal,
  matchesEmptyInput: (rows: readonly string[], cursorRow: number) => boolean,
  table: ScreenFactTable,
  emptyRow: string,
): string | undefined {
  return readStagedComposerFrame(
    readIdleComposerFrame(terminal, table),
    matchesEmptyInput,
    emptyRow,
  );
}

/** Reuse one completed idle-frame classification for normal and whitespace drafts. */
export function readStagedComposerFrame(
  current: ReturnType<typeof readIdleComposerFrame>,
  matchesEmptyInput: (rows: readonly string[], cursorRow: number) => boolean,
  emptyRow: string,
): string | undefined {
  if (!current) return undefined;
  const { frame, cursorRow } = current;
  // Placeholder-shaped input remains ambiguous even with a stale advanced cursor.
  if (matchesEmptyInput(frame.lines, cursorRow)) return undefined;
  const rows = frame.lines.slice(0, cursorRow + 1);
  const start = rows.findLastIndex(
    (row) => row.startsWith(emptyRow.charAt(0)) && /^[ \u00a0]$/.test(row.charAt(1)),
  );
  if (start < 0 || !rows.slice(start + 1).every((row) => row.startsWith("  "))) return undefined;
  // A wrapped/multiline Codex draft continues with two-space indentation. Replace
  // only the cursor-owned draft region; transcript and unknown overlays remain.
  const normalized = [
    ...frame.lines.slice(0, start),
    emptyRow,
    ...frame.lines.slice(cursorRow + 1),
  ];
  return matchesEmptyInput(normalized, start) ? rows.slice(start).join("\n") : undefined;
}

/** A whitespace draft is visible only through its advanced caret on the live prompt row. */
export function readStagedWhitespace(
  current: ReturnType<typeof readIdleComposerFrame>,
  matchesEmptyInput: (rows: readonly string[], cursorRow: number) => boolean,
  emptyRow: string,
): boolean {
  if (!current || current.frame.cursorX <= 2) return false;
  const { frame, cursorRow } = current;
  const row = frame.lines[cursorRow]!;
  if (row.charAt(0) !== emptyRow.charAt(0) || !/^[ \u00a0]*$/.test(row.slice(1))) return false;
  const normalized = [...frame.lines];
  normalized[cursorRow] = emptyRow;
  return matchesEmptyInput(normalized, cursorRow);
}

export function readIdleComposerFrame(terminal: ElwoodTerminal, table: ScreenFactTable) {
  const frame = currentRenderedFrame(terminal, "live");
  // The native caret prefix occupies two cells; staged text/chips advance beyond them.
  if (!(frame && settledCursorVisible(terminal.xterm)) || frame.cursorX < 2) return undefined;
  const { facts } = readScreenFacts(table, { text: frame.text, title: terminal.title });
  if (facts.working_visible || facts.blocking_prompt_visible) return undefined;
  const cursorRow = frame.cursorY;
  if (cursorRow >= frame.lines.length) return undefined;
  return { frame, cursorRow };
}
