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

export type QuestionFailurePhase =
  | "frame_wait"
  | "adapter"
  | "terminal_write"
  | "native_acceptance"
  | "revoked";

/** Fixed diagnostic categories never carry a caller's answer or a raw exception. */
export function questionAnswerFailed(phase?: QuestionFailurePhase) {
  return questionError(
    "question_answer_failed",
    "The native question answer could not be confirmed. Refresh pending questions and inspect the terminal before retrying.",
    phase === undefined ? {} : { phase },
  );
}
