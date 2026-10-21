/** Public question failures for provider-independent control code (PRD §10). */
import { type ElwoodError, elwoodError } from "../errors.ts";
export type QuestionErrorCode =
  | "question_not_found"
  | "invalid_question_answer"
  | "question_answer_failed";

export function questionError(
  code: QuestionErrorCode,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): ElwoodError {
  return elwoodError(code, message, details);
}

export type QuestionFailureCategory =
  | "frame_wait"
  | "adapter"
  | "terminal_write"
  | "native_acceptance"
  | "aborted";

/** Fixed diagnostic categories never carry a caller's answer or a raw exception. */
export function questionAnswerFailed(category?: QuestionFailureCategory) {
  return questionError(
    "question_answer_failed",
    "The native question answer could not be confirmed. Refresh pending questions and inspect the terminal before retrying.",
    category === undefined ? {} : { category },
  );
}
