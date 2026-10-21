/** Private provider interface for guarded native questions (PRD §4). */
import type { TerminalSnapshot } from "../../terminal/headless.ts";
import type { ElwoodActivityEvent } from "../activity/index.ts";
import type { ElwoodQuestionRequest } from "./types.ts";
import type { ValidatedQuestionAnswer } from "./validate.ts";

export type QuestionFrame = TerminalSnapshot & {
  readonly cursorRow: number;
  readonly cursorVisible?: boolean;
};
export type QuestionIo = {
  readonly signal: AbortSignal;
  frame(): QuestionFrame | undefined;
  wait(test: (frame: QuestionFrame) => boolean): Promise<QuestionFrame>;
  write(input: string, expected: (frame: QuestionFrame) => boolean): Promise<void>;
};
export interface QuestionAdapter {
  observe(event: ElwoodActivityEvent): void;
  render(frame: QuestionFrame): void;
  blocksInput(): boolean;
  answer(
    request: ElwoodQuestionRequest,
    answers: readonly ValidatedQuestionAnswer[],
    io: QuestionIo,
  ): Promise<void>;
}
