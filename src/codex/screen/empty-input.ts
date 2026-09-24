/** Observe an empty Codex input during either idle or active work (PRD §5.3, C-API-56). */
import { emptyInputFrame } from "../../core/input/empty-frame.ts";
import type { ElwoodTerminal } from "../../terminal/headless.ts";
import { codexComposerRowsEmpty } from "./clearance.ts";

export function codexEmptyInputFrame(terminal: ElwoodTerminal) {
  return emptyInputFrame(terminal, emptyRows);
}

function emptyRows(rows: readonly string[], cursorRow: number): boolean {
  // Native 0.156.1 right-aligns this badge even with a model-only status line.
  const normalized = rows.map((row) => row.replace(/ {2,}⚠ \d+ warnings? · f2 to view\s*$/, ""));
  return codexComposerRowsEmpty(normalized, cursorRow);
}
