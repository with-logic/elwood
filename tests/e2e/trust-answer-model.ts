/**
 * Direct-responder helpers for the real Claude trust frame (C-E2E-09): the keys that
 * answer it and a minimal repaint model of Elwood's absolute cursor selection, so the
 * captured frame can be answered without driving the live CLI.
 */
import {
  cursorOptionRows,
  optionKeystrokes,
  selectableOptions,
} from "../../src/core/terminal-options.ts";
import { claudeComposer } from "../fixtures/trust-composer.ts";

/**
 * The raw PTY input that answers the real frame's affirmative option, if any: its number
 * then Enter on a numbered layout; on a cursor layout, the absolute selection (Home, then
 * one Down per option above it) and then that selection again with Enter.
 */
export function affirmativeOptionKeys(frame: string): string | undefined {
  const option = selectableOptions(frame).find((candidate) =>
    /\byes\b|proceed|trust/i.test(candidate.label),
  );
  return option === undefined ? undefined : optionKeystrokes(option).join("");
}

/** The cursor glyphs `cursorOptionRows` accepts on a selected row. */
const caretRow = /^(\s*)([❯›])\s/;

/** Repaints `frame` after `input`: an absolute selection moves the caret, Enter clears. */
export function advancePromptFrame(frame: string, input: string): string {
  if (input.includes("\r")) return claudeComposer;
  const lines = frame.split("\n");
  const block = cursorOptionRows(lines);
  const selected = lines.findIndex((line) => caretRow.test(line));
  const caret = caretRow.exec(lines[selected] ?? "");
  const target = (block?.firstRow ?? 0) + input.split("\u001b[B").length - 1;
  const targetLine = lines[target];
  const selectedLine = lines[selected];
  if (
    block === undefined ||
    caret === null ||
    selectedLine === undefined ||
    targetLine === undefined ||
    !input.startsWith("\u001b[H") ||
    target > block.lastRow
  )
    return frame;
  const [, indent = "", glyph = "❯"] = caret;
  const column = indent.length;
  lines[selected] = `${selectedLine.slice(0, column)} ${selectedLine.slice(column + 1)}`;
  lines[target] = `${targetLine.slice(0, column)}${glyph}${targetLine.slice(column + 1)}`;
  return lines.join("\n");
}
