/** Native-indented custom editor rows expose chrome-shaped answer collisions (PRD §4). */
import type { QuestionFrame } from "../../../src/core/questions/adapter.ts";
import { nativeFrame } from "./native-frame.ts";
import type { Mode } from "./owned-fixtures.ts";

export function singleEmpty(mode: Mode): QuestionFrame {
  const frame = nativeFrame(`editor/${mode}-literal-empty.json`);
  const lines = frame.lines
    .filter((line) => line.trim() !== "1 of 2")
    .map((line) => line.replace("Question 1/2 (2 unanswered)", "Question 1/1 (1 unanswered)"));
  const cursorRow = frame.cursorRow - (mode === "queued" ? 1 : 0);
  return { ...frame, lines, text: lines.join("\n"), cursorRow, cursorY: cursorRow };
}
export function typedChrome(mode: Mode, text: string): QuestionFrame {
  const frame = singleEmpty(mode);
  const rows = text
    .split("\n")
    .map((line, index) => (mode === "queued" ? "  " : index === 0 ? "  › " : "    ") + line);
  const lines = [
    ...frame.lines.slice(0, frame.cursorRow),
    ...rows,
    ...frame.lines.slice(frame.cursorRow + 1),
  ].slice(0, frame.rows);
  const cursorRow = frame.cursorRow + rows.length - 1;
  const before = rows.at(-1)!;
  return {
    ...frame,
    lines,
    text: lines.join("\n"),
    cursorRow,
    cursorY: cursorRow,
    cursorX: before.length,
    cursorVisible: true,
    cursorCellDimmed: false,
    cursorLineBefore: before,
  };
}
