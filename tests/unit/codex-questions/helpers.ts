/** Pure captured Codex question frames (PRD §4). */
import type { QuestionFrame } from "../../../src/core/questions/adapter.ts";
import { fixture } from "./fixtures.ts";

export { fixture } from "./fixtures.ts";
export function frame(text: string): QuestionFrame {
  const lines = text.split("\n");
  const cursorRow = lines.findLastIndex((line) => line.trim().length > 0) + 1;
  return { text, lines, cols: 140, rows: 45, cursorX: 0, cursorY: cursorRow, cursorRow };
}
export function captured(name: string): QuestionFrame {
  return frame(fixture(name));
}
