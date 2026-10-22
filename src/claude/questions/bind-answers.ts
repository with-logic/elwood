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

/** Bind the core-validated, dense, request-ordered batch before native IO. */
export function bindClaudeQuestionAnswers(
  request: ElwoodQuestionRequest,
  answers: readonly ValidatedQuestionAnswer[],
): readonly BoundClaudeQuestionAnswer[] {
  return request.questions.map((question, questionIndex) => {
    const answer = answers[questionIndex]!;
    // Claude Other replaces a choice; it cannot carry an additional note.
    const hasText = answer.text !== undefined;
    const hasSelectedOptions = answer.optionIndexes.length > 0;
    if (hasText && hasSelectedOptions) throw questionAnswerFailed();
    const labels = answer.optionIndexes.map((optionIndex) => {
      const option = question.options[optionIndex];
      if (option === undefined) throw questionAnswerFailed();
      return option.label;
    });
    const otherCursorIndex = question.options.length;
    const submitCursorIndex = otherCursorIndex + 1;
    const cursorBySelection = {
      single: hasText ? otherCursorIndex : answer.optionIndexes[0]!,
      multiple: submitCursorIndex,
      none: otherCursorIndex,
    } satisfies Readonly<Record<ElwoodQuestion["selection"], number>>;
    const targetCursorIndex = cursorBySelection[question.selection];
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
