/** Add measured native editor cursor provenance to scripted frames (PRD §4). */
import type { QuestionFrame } from "../../../src/core/questions/adapter.ts";
import { frame } from "./helpers.ts";

export function editorFrame(
  source: QuestionFrame,
  options: {
    readonly editorLine: string;
    readonly cursorLineBefore: string;
    readonly dimmed: boolean;
  },
): QuestionFrame {
  const { editorLine, cursorLineBefore, dimmed } = options;
  const cursorRow = source.lines.findLastIndex((line) => line.trimEnd() === editorLine);
  if (cursorRow < 0) throw new Error("Scripted native editor row is missing");
  return {
    ...source,
    cursorRow,
    cursorY: cursorRow,
    cursorX: cursorLineBefore.length,
    cursorVisible: true,
    cursorCellDimmed: dimmed,
    cursorLineBefore,
  };
}

/** Native notes chrome and cursor evidence for an empty or typed modal editor. */
export function notesFrame(source: QuestionFrame, text = "Add notes"): QuestionFrame {
  const placeholder = text === "Add notes";
  return editorFrame(
    frame(
      source.text.replace(
        /^ {2}tab to add notes \| enter to submit (answer|all) \| ←\/→ to navigate questions \| esc to interrupt/m,
        `  › ${text}\n\n  tab or esc to clear notes | enter to submit $1`,
      ),
    ),
    {
      editorLine: `  › ${text}`,
      cursorLineBefore: placeholder ? "  › " : `  › ${text}`,
      dimmed: placeholder,
    },
  );
}
