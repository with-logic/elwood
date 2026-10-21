/** Observe an empty Codex input during either idle or active work (PRD §5.3, C-API-56). */
import { emptyInputFrame } from "../../core/input/empty-frame.ts";
import type { ElwoodTerminal } from "../../terminal/headless.ts";
import { codexComposerRowsEmpty } from "./clearance.ts";

export function codexEmptyInputFrame(terminal: ElwoodTerminal) {
  return emptyInputFrame(terminal, codexEmptyInputRows);
}

export function codexEmptyInputRows(rows: readonly string[], cursorRow: number): boolean {
  return codexComposerRowsEmpty(rows, cursorRow);
}
