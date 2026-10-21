/** Private provider interface for guarded native questions (PRD §4). */
import type { ElwoodActivityEvent } from "../activity/index.ts";
import type { QuestionFrame, QuestionIo } from "./io.ts";
import type { ElwoodQuestionRequest } from "./types.ts";
import type { ValidatedQuestionAnswer } from "./validate.ts";

export type { QuestionFrame, QuestionIo } from "./io.ts";

export interface QuestionAdapter {
  observe(event: ElwoodActivityEvent): void;
  render(frame: QuestionFrame): void;
  blocksInput(): boolean;
  /** Entry i answers request.questions[i], using indexes into that question's ordered options. */
  answer(
    request: ElwoodQuestionRequest,
    answersInRequestQuestionOrder: readonly ValidatedQuestionAnswer[],
    io: QuestionIo,
  ): Promise<void>;
}
