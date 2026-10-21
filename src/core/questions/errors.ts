/** Private question failures for provider-independent control code (PRD §4). */
export type QuestionErrorCode =
  | "question_not_found"
  | "invalid_question_answer"
  | "question_answer_failed";

export function questionError(
  code: QuestionErrorCode,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): Error & {
  readonly code: QuestionErrorCode;
  readonly details: Readonly<Record<string, unknown>>;
} {
  return Object.assign(new Error(message), { code, details });
}
