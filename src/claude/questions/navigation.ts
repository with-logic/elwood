/** Verify every private Claude question navigation step (PRD §4). */

import { arrowDown, arrowUp } from "../../core/input/constants.ts";
import type { QuestionFrame, QuestionIo } from "../../core/questions/adapter.ts";
import { questionError } from "../../core/questions/errors.ts";
import type { ElwoodQuestionRequest } from "../../core/questions/types.ts";
import { parseClaudeQuestionScreen } from "./screen.ts";

/** questionIndex addresses request.questions, not an option; only that native question
 * may authorize navigation. Each move waits for its completed successor frame. */
export function questionNavigation(
  request: ElwoodQuestionRequest,
  questionIndex: number,
  io: QuestionIo,
) {
  const at = (frame: QuestionFrame) => {
    const screen = parseClaudeQuestionScreen(frame, request.questions);
    return screen?.kind === "question" && screen.questionIndex === questionIndex
      ? screen
      : undefined;
  };
  const read = () => {
    const frame = io.frame();
    const screen = frame && at(frame);
    if (!screen) throw questionLayoutFailed();
    return screen;
  };
  const move = async (targetCursorIndex: number) => {
    for (;;) {
      const screen = read();
      if (screen.cursor === targetCursorIndex) return;
      const delta = targetCursorIndex > screen.cursor ? 1 : -1;
      await io.write(
        delta > 0 ? arrowDown : arrowUp,
        (frame) => at(frame)?.cursor === screen.cursor,
      );
      await io.wait((frame) => at(frame)?.cursor === screen.cursor + delta);
    }
  };
  return { at, read, move };
}
export function questionLayoutFailed() {
  return questionError("question_answer_failed", "The native question layout is not supported.");
}
