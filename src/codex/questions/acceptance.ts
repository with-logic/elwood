/** Compare complete owned native answers without retaining them after PRD §4 attempts. */
import { isRecord } from "../../core/predicates.ts";
import { questionAnswerFailed } from "../../core/questions/errors.ts";
import type { ValidatedQuestionAnswer } from "../../core/questions/validate.ts";
import type { Candidate } from "./candidate-store.ts";
import type { QuestionReply } from "./records.ts";

// Rust str::trim uses Unicode White_Space, which excludes JavaScript's FEFF.
function nativeTrim(value: string): string {
  const whitespace = /\p{White_Space}/u;
  let start = 0;
  let end = value.length;
  while (start < end && whitespace.test(value[start]!)) start++;
  while (end > start && whitespace.test(value[end - 1]!)) end--;
  return value.slice(start, end);
}
export class AnswerExpectations {
  private readonly pending = new Map<
    Candidate,
    {
      readonly values: readonly (readonly string[])[];
      readonly release: () => void;
    }
  >();
  /** Arm values in question order before driver input.
   * Text normalizes CRLF/lone CR to LF, then trims Rust Unicode White_Space.
   * Queued uses provided text (even empty), otherwise the whitespace-trimmed label.
   * Blocking keeps the verbatim label, then adds user_note only for nonempty normalized text.
   * Label line endings are not normalized. */
  expect(
    candidate: Candidate,
    answers: readonly ValidatedQuestionAnswer[],
    signal: AbortSignal,
  ): () => void {
    if (signal.aborted || this.pending.has(candidate)) throw questionAnswerFailed();
    const values = candidate.questions.map((question, index) => {
      const answer = answers[index]!;
      const label =
        question.definition.options[
          answer.optionIndexes[0] ?? question.definition.options.length - 1
        ]?.label;
      const text =
        answer.text === undefined ? undefined : nativeTrim(answer.text.replace(/\r\n?/g, "\n"));
      if (candidate.queued) return [text ?? nativeTrim(label!)];
      return [label!, ...(text ? [`user_note: ${text}`] : [])];
    });
    const release = () => {
      if (this.pending.get(candidate)?.release === release) this.pending.delete(candidate);
      signal.removeEventListener("abort", release);
    };
    this.pending.set(candidate, { values, release });
    signal.addEventListener("abort", release, { once: true });
    return release;
  }
  clear(candidate: Candidate): void {
    this.pending.get(candidate)?.release();
  }
  /** Unowned queued replies retain manual native acceptance; owned replies require a full match. */
  isQueuedReplyAccepted(candidate: Candidate, replies: readonly QuestionReply[]): boolean {
    const expected = this.pending.get(candidate);
    if (!expected) return true;
    const matching = replies.filter((reply) => reply.questionItemId === candidate.nativeKey);
    return matching.length === 1 && matching[0]!.answer === expected.values[0]![0];
  }
  /** Without an owned expectation, undefined delegates to the caller's legacy manual check. */
  matchesOwnedBlockingAnswers(candidate: Candidate, answers: unknown): boolean | undefined {
    const expected = this.pending.get(candidate);
    if (!expected) return undefined;
    return (
      isRecord(answers) &&
      Object.keys(answers).length === candidate.questions.length &&
      candidate.questions.every((question, index) => {
        const native = answers[String(question.nativeId)];
        const values = expected.values[index]!;
        const actual = isRecord(native) ? native["answers"] : undefined;
        return (
          Array.isArray(actual) &&
          actual.length === values.length &&
          values.every((value, item) => actual[item] === value)
        );
      })
    );
  }
}
