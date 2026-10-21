/** Validate a complete answer batch before native input (PRD §5.10, C-QUESTION-02). */
import { elwoodError } from "../errors.ts";
import { sanitizePasteText } from "../input/sanitize.ts";
import type {
  ElwoodQuestionAnswer,
  ElwoodQuestionAnswerOptions,
  ElwoodQuestionRequest,
} from "./types.ts";

export type ValidatedQuestionAnswer = {
  readonly optionIndexes: readonly number[];
  readonly text?: string;
};
export function questionTimeout(options?: ElwoodQuestionAnswerOptions): number {
  const value = options?.timeoutMs ?? 20_000;
  if (!Number.isFinite(value) || value <= 0) throw invalid();
  return value;
}
export function validateQuestionAnswers(
  request: ElwoodQuestionRequest,
  answers: readonly ElwoodQuestionAnswer[],
): readonly ValidatedQuestionAnswer[] {
  if (!Array.isArray(answers) || answers.length !== request.questions.length) throw invalid();
  const seen = new Set<string>();
  for (const answer of answers) {
    if (
      !answer ||
      seen.has(answer.questionId) ||
      !request.questions.some((q) => q.id === answer.questionId)
    )
      throw invalid();
    seen.add(answer.questionId);
  }
  return request.questions.map((question) => {
    const answer = answers.find((item) => item.questionId === question.id)!;
    const ids = answer.optionIds ?? [];
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length) throw invalid();
    const indexes = ids.map((id) => question.options.findIndex((option) => option.id === id));
    const text = answer.text;
    if (
      indexes.some((index) => index < 0) ||
      (question.selection !== "multiple" && ids.length > 1) ||
      (question.selection === "none" && ids.length > 0) ||
      (text !== undefined &&
        (typeof text !== "string" ||
          !text.trim() ||
          sanitizePasteText(text) !== text ||
          question.textMode === "none")) ||
      (text !== undefined && ids.length > 0 && question.textMode !== "additional") ||
      (ids.length === 0 && text === undefined)
    )
      throw invalid();
    return {
      optionIndexes: Object.freeze(indexes.sort((left, right) => left - right)),
      ...(text === undefined ? {} : { text }),
    };
  });
}
function invalid() {
  return elwoodError(
    "invalid_question_answer",
    "The complete question answer batch or options are invalid.",
  );
}
