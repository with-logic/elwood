/**
 * The one shared `ElwoodActivityEvent` builder for unit tests: a minimal valid
 * transcript-sourced assistant message with non-progress fields overridden (PRD §5.4).
 */

import type { ElwoodActivityEvent } from "../../src/core/activity/index.ts";

type QuestionActivity = Extract<ElwoodActivityEvent, { kind: "question" }>;
type ActivityInput =
  | Partial<Exclude<ElwoodActivityEvent, { readonly kind: "assistant_progress" | "question" }>>
  | (Partial<Omit<QuestionActivity, "kind" | "question">> & {
      kind: "question";
      question: QuestionActivity["question"];
    });
export function activity(partial: ActivityInput = {}): ElwoodActivityEvent {
  if (partial.kind === "question") {
    const { question } = partial;
    const base = {
      elwoodSessionId: "s1",
      agent: "claude",
      ...partial,
      source: "terminal",
      label: question.phase,
    } as const;
    return question.phase === "raised"
      ? { ...base, label: question.phase, question }
      : { ...base, label: question.phase, question };
  }
  return {
    elwoodSessionId: "s1",
    agent: "claude",
    source: "transcript",
    kind: "assistant_message",
    label: "assistant",
    ...partial,
  };
}
