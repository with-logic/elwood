/** Bind normalized answers to request order and physical native targets (PRD §4). */
import { questionAnswerFailed } from "../../core/questions/errors.ts";
import type { ElwoodQuestion, ElwoodQuestionRequest } from "../../core/questions/types.ts";
import type { ValidatedQuestionAnswer } from "../../core/questions/validate.ts";

export type BoundClaudeQuestionAnswer = {
  /** Position in the request's native question order. */
  readonly questionIndex: number;
  readonly question: ElwoodQuestion;
  readonly answer: ValidatedQuestionAnswer;
  readonly target: number;
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
    const labels: string[] = [];
    for (const [position, optionIndex] of answer.optionIndexes.entries()) {
      const option = question.options[optionIndex];
      if (
        !(Object.hasOwn(answer.optionIndexes, position) && Number.isInteger(optionIndex) && option)
      )
        throw questionAnswerFailed();
      labels.push(option.label);
    }
    const target =
      question.selection === "multiple"
        ? question.options.length + 1
        : answer.text === undefined
          ? answer.optionIndexes[0]
          : question.options.length;
    if (target === undefined) throw questionAnswerFailed();
    return {
      questionIndex,
      question,
      answer,
      target,
      reviewValue: answer.text ?? labels.join(", "),
    };
  });
}
