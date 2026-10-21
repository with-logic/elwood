/** Verify every private Claude question navigation step (PRD §4). */

import type { QuestionFrame, QuestionIo } from "../../core/questions/adapter.ts";
import { questionError } from "../../core/questions/errors.ts";
import type { ElwoodQuestionRequest } from "../../core/questions/types.ts";
import { parseClaudeQuestionScreen } from "./screen.ts";

export function questionNavigation(request: ElwoodQuestionRequest, index: number, io: QuestionIo) {
  const at = (frame: QuestionFrame) => {
    const screen = parseClaudeQuestionScreen(frame, request.questions);
    return screen?.kind === "question" && screen.questionIndex === index ? screen : undefined;
  };
  const read = () => {
    const frame = io.frame();
    const screen = frame && at(frame);
    if (!screen) throw questionLayoutFailed();
    return screen;
  };
  const move = async (target: number) => {
    for (;;) {
      const screen = read();
      if (screen.cursor === target) return;
      const delta = target > screen.cursor ? 1 : -1;
      await io.write(
        delta > 0 ? "\x1b[B" : "\x1b[A",
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
