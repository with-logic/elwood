/** A Claude completion acknowledges an Elwood answer only with its submitted values (PRD §5.10). */
import { record } from "../../core/activity/meta.ts";
import { questionAnswerFailed } from "../../core/questions/errors.ts";
import type { QuestionCloseReason } from "../../core/questions/types.ts";
import type { BoundClaudeQuestionAnswer } from "./bind-answers.ts";

/** The `answers` a completion must report for an Elwood answer, keyed by question prompt. */
export type ClaudeExpectedAnswers = ReadonlyMap<string, string>;

/** Fails before any write when prompts repeat: Claude's completion could not report them apart. */
export function claudeExpectedAnswers(
  bound: readonly BoundClaudeQuestionAnswer[],
): ClaudeExpectedAnswers {
  const expected = new Map(
    bound.map(({ question, nativeValue }) => [question.prompt, nativeValue]),
  );
  if (expected.size !== bound.length) throw questionAnswerFailed();
  return expected;
}

/**
 * How a matching native hook closes its request. A completion is `answered` when no Elwood answer
 * has written (`expected` is undefined: a person answered natively), or when it reports exactly
 * the expected values; otherwise it is `unavailable`. Any other closing hook is `cancelled` when
 * Claude marks it an interrupt, and `unavailable` otherwise.
 */
export function claudeCloseReason(
  hookEventName: unknown,
  hook: Readonly<Record<string, unknown>>,
  expected: ClaudeExpectedAnswers | undefined,
): QuestionCloseReason {
  if (hookEventName === "PostToolUse") {
    const acknowledged = expected === undefined || reportsExpected(hook, expected);
    return acknowledged ? "answered" : "unavailable";
  }
  return hook["is_interrupt"] === true ? "cancelled" : "unavailable";
}

function reportsExpected(
  hook: Readonly<Record<string, unknown>>,
  expected: ClaudeExpectedAnswers,
): boolean {
  const reported = record(record(hook["tool_input"])["answers"]);
  return (
    Object.keys(reported).length === expected.size &&
    [...expected].every(([prompt, value]) => reported[prompt] === value)
  );
}
