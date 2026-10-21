/** Validate a complete answer batch before native input (PRD §4). */

import { sanitizePasteText } from "../input/sanitize.ts";
import { questionError } from "./errors.ts";
import type {
  ElwoodQuestion,
  ElwoodQuestionAnswer,
  ElwoodQuestionAnswerOptions,
  ElwoodQuestionRequest,
} from "./types.ts";

/** Entries follow request-question order; option indexes follow native option order. */
export type ValidatedQuestionAnswer = {
  readonly optionIndexes: readonly number[];
  readonly text?: string;
};
const DEFAULT_QUESTION_TIMEOUT_MS = 20_000;
const MAX_ANSWER_BATCH_TEXT_BYTES = 8 * 1024 * 1024;

/** Return a positive finite duration in milliseconds. The 20-second default bounds
 * stalled native confirmation; callers can extend it for slower interfaces. */
export function questionTimeoutMs(options?: ElwoodQuestionAnswerOptions): number {
  if (options !== undefined && (typeof options !== "object" || options === null)) throw invalid();
  const timeoutMs = options?.timeoutMs;
  const value = timeoutMs === undefined ? DEFAULT_QUESTION_TIMEOUT_MS : timeoutMs;
  if (!Number.isFinite(value) || value <= 0) throw invalid();
  return value;
}
/** Require exactly one answer per question within its selection/text capabilities
 * and the 8 MiB text budget; return native indexes in request-question order.
 * The caller owns checking whether the request is still live. */
export function validateQuestionAnswers(
  request: ElwoodQuestionRequest,
  answers: readonly ElwoodQuestionAnswer[],
): readonly ValidatedQuestionAnswer[] {
  if (!Array.isArray(answers)) throw invalid();
  const answerCount = answers.length;
  if (answerCount !== request.questions.length) throw invalid();
  let textBytes = 0;
  const validated = new Map<string, ValidatedQuestionAnswer>();
  const questionsById = new Map(request.questions.map((question) => [question.id, question]));
  for (let index = 0; index < answerCount; index++) {
    if (!Object.hasOwn(answers, index)) throw invalid();
    const answer = answers[index];
    if (!answer) throw invalid();
    const { questionId, optionIds, text } = answer;
    const question = questionsById.get(questionId);
    if (!question || validated.has(questionId)) throw invalid();
    const indexes = questionOptionIndexes(question, optionIds === undefined ? [] : optionIds);
    if (typeof text === "string") textBytes += Buffer.byteLength(text, "utf8");
    if (textBytes > MAX_ANSWER_BATCH_TEXT_BYTES) throw invalid();
    validated.set(questionId, validateAnswer(question, indexes, text));
  }
  return request.questions.map((question) => validated.get(question.id)!);
}
function validateAnswer(
  question: ElwoodQuestion,
  indexes: number[],
  text: string | undefined,
): ValidatedQuestionAnswer {
  const invalidSelection = indexes.some((index) => index < 0);
  const invalidText =
    text !== undefined &&
    (typeof text !== "string" ||
      !text.isWellFormed() ||
      !text.trim() ||
      sanitizePasteText(text) !== text ||
      question.textMode === "none");
  const incompatibleText =
    text !== undefined && indexes.length > 0 && question.textMode !== "additional";
  const missingAnswer = indexes.length === 0 && text === undefined;
  if (invalidSelection || invalidText || incompatibleText || missingAnswer) throw invalid();
  return {
    optionIndexes: Object.freeze(indexes.sort((left, right) => left - right)),
    ...(text === undefined ? {} : { text }),
  };
}
function questionOptionIndexes(question: ElwoodQuestion, ids: readonly string[]): number[] {
  if (!Array.isArray(ids)) throw invalid();
  const length = ids.length;
  const invalidCount =
    length > question.options.length ||
    (question.selection === "single" && length > 1) ||
    (question.selection === "none" && length > 0);
  if (invalidCount) throw invalid();
  const selected = new Set<string>();
  const optionIndexesById = new Map(question.options.map((option, index) => [option.id, index]));
  const indexes: number[] = [];
  for (let index = 0; index < length; index++) {
    const id: unknown = ids[index];
    if (!Object.hasOwn(ids, index) || typeof id !== "string" || selected.has(id)) throw invalid();
    selected.add(id);
    indexes.push(optionIndexesById.get(id) ?? -1);
  }
  return indexes;
}
function invalid() {
  return questionError(
    "invalid_question_answer",
    "The complete question answer batch or options are invalid.",
  );
}
