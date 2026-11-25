/** A Claude completion acknowledges an Elwood answer only with its submitted values (PRD §5.10). */
import { record } from "../../core/activity/meta.ts";
import type { QuestionCloseReason } from "../../core/questions/types.ts";
import type { BoundClaudeQuestionAnswer } from "./bind-answers.ts";

/** The `answers` a completion must report for an Elwood answer, keyed by question prompt. */
export type ClaudeExpectedAnswers = ReadonlyMap<string, string>;

export function claudeExpectedAnswers(
  bound: readonly BoundClaudeQuestionAnswer[],
): ClaudeExpectedAnswers {
  return new Map(bound.map(({ question, nativeValue }) => [question.prompt, nativeValue]));
}

/** How a native hook closes its request. Without expected answers, a person answered natively. */
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
