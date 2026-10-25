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

/** The raw PTY keys needed to select the real frame's affirmative option, if any. */
export function affirmativeOptionKeys(frame: string): string | undefined {
  const option = selectableOptions(frame).find((candidate) =>
    /\byes\b|proceed|trust/i.test(candidate.label),
  );
  return option === undefined ? undefined : optionKeystrokes(option).join("");
}

/** Repaints `frame` after `input`: an absolute selection moves the caret, Enter clears. */
export function advancePromptFrame(frame: string, input: string): string {
  if (input.includes("\r")) return claudeComposer;
  const lines = frame.split("\n");
  const block = cursorOptionRows(lines);
  const selected = lines.findIndex((line) => /^\s*❯\s/.test(line));
  const target = (block?.firstRow ?? 0) + input.split("\u001b[B").length - 1;
  if (block === undefined || !input.startsWith("\u001b[H") || target > block.lastRow) return frame;
  const column = (lines[selected] as string).indexOf("❯");
  const mark = (row: number, caret: string) => {
    lines[row] =
      `${(lines[row] as string).slice(0, column)}${caret}${(lines[row] as string).slice(column + 1)}`;
  };
  mark(selected, " ");
  mark(target, "❯");
  return lines.join("\n");
}
