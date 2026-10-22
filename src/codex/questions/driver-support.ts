/** Limit the private Codex driver to supported native question selectors (PRD §4). */
import { questionAnswerFailed } from "../../core/questions/errors.ts";
import type { QuestionDefinition } from "../../core/questions/types.ts";

export type SupportedDriverQuestion = QuestionDefinition & {
  readonly selection: "none" | "single";
};

export function assertSupportedQuestions(
  questions: readonly QuestionDefinition[],
): asserts questions is readonly SupportedDriverQuestion[] {
  if (
    !questions.every((question) => question.selection === "none" || question.selection === "single")
  )
    throw questionAnswerFailed();
}
