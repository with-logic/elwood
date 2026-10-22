/** Bind normalized answers to request order and physical native targets (PRD §4). */
import { questionAnswerFailed } from "../../core/questions/errors.ts";
import type { ElwoodQuestion, ElwoodQuestionRequest } from "../../core/questions/types.ts";
import type { ValidatedQuestionAnswer } from "../../core/questions/validate.ts";

export type BoundClaudeQuestionAnswer = {
  /** Position in the request's native question order. */
  readonly questionIndex: number;
  readonly question: ElwoodQuestion;
  readonly answer: ValidatedQuestionAnswer;
  readonly otherCursorIndex: number;
  readonly targetCursorIndex: number;
  readonly reviewValue: string;
};

/** Bind the whole normalized batch before any frame read or terminal write. */
export function bindClaudeQuestionAnswers(
  request: ElwoodQuestionRequest,
  answers: readonly ValidatedQuestionAnswer[],
): readonly BoundClaudeQuestionAnswer[] {
  if (answers.length === 0 || answers.length !== request.questions.length)
    throw questionAnswerFailed();
  return request.questions.map((question, questionIndex) => {
    const answer = answers[questionIndex];
    if (!(Object.hasOwn(answers, questionIndex) && answer)) throw questionAnswerFailed();
    // Claude Other replaces a choice; it cannot carry an additional note.
    const hasText = answer.text !== undefined;
    const hasSelectedOptions = answer.optionIndexes.length > 0;
    if (hasText && hasSelectedOptions) throw questionAnswerFailed();
    const labels: string[] = [];
    for (const [position, optionIndex] of answer.optionIndexes.entries()) {
      const option = question.options[optionIndex];
      const hasOwnIndex = Object.hasOwn(answer.optionIndexes, position);
      const isIntegerIndex = Number.isInteger(optionIndex);
      const hasMatchingOption = option !== undefined;
      if (!(hasOwnIndex && isIntegerIndex && hasMatchingOption)) throw questionAnswerFailed();
      labels.push(option.label);
    }
    const otherCursorIndex = question.options.length;
    let targetCursorIndex: number | undefined;
    if (question.selection === "multiple") {
      const submitCursorIndex = otherCursorIndex + 1;
      targetCursorIndex = submitCursorIndex;
    } else if (hasText) {
      targetCursorIndex = otherCursorIndex;
    } else {
      targetCursorIndex = answer.optionIndexes[0];
    }
    if (targetCursorIndex === undefined) throw questionAnswerFailed();
    return {
      questionIndex,
      question,
      answer,
      otherCursorIndex,
      targetCursorIndex,
      reviewValue: answer.text ?? labels.join(", "),
    };
  });
}
