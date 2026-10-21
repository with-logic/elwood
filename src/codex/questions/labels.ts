/** Derive the native queued free-text option label from question choices (PRD §4). */
import type { QuestionDefinition } from "../../core/questions/types.ts";

export function queuedOtherLabel(question: QuestionDefinition): string {
  return question.options.some((option) => option.label.toLowerCase() === "other")
    ? "Other (write an answer)"
    : "Other";
}
