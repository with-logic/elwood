/** Bind normalized answers to request order and physical native targets (PRD §5.10). */
import { questionAnswerFailed } from "../../core/questions/errors.ts";
import type { ElwoodQuestion, ElwoodQuestionRequest } from "../../core/questions/types.ts";
import type { ValidatedQuestionAnswer } from "../../core/questions/validate.ts";

export type BoundClaudeQuestionAnswer = {
  /** Position in the request's native question order. */
  readonly questionIndex: number;
  readonly question: ElwoodQuestion;
  /** The validated answer, with `text` line endings as LF: what Elwood pastes. */
  readonly answer: ValidatedQuestionAnswer;
  readonly otherCursorIndex: number;
  readonly targetCursorIndex: number;
  /** What Claude's review shows and its completion reports: text, or labels joined by `, `. */
  readonly nativeValue: string;
};

/** Bind the core-validated, dense, request-ordered batch before native IO, with LF line endings. */
export function bindClaudeQuestionAnswers(
  request: ElwoodQuestionRequest,
  answers: readonly ValidatedQuestionAnswer[],
): readonly BoundClaudeQuestionAnswer[] {
  return request.questions.map((question, questionIndex) => {
    const validated = answers[questionIndex]!;
    // Claude's editor keeps a pasted CRLF pair as CR. Elwood pastes every line break as LF,
    // the one ending Claude keeps unchanged.
    const text = validated.text?.replace(/\r\n?/g, "\n");
    const answer = text === undefined ? validated : { ...validated, text };
    // Claude Other replaces a choice; it cannot carry an additional note.
    const hasText = text !== undefined;
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
      nativeValue: text ?? labels.join(", "),
    };
  });
}
