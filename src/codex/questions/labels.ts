/** Derive the native queued free-text option label from question choices (PRD §4). */
import type { QuestionDefinition } from "../../core/questions/types.ts";

export type QueuedOtherLabel = "Other" | "Other (write an answer)";
export type NativeDraftPlaceholder = QueuedOtherLabel | "Add notes" | "Type your answer";

export function queuedOtherLabel(question: QuestionDefinition): QueuedOtherLabel {
  return question.options.some((option) => option.label.toLowerCase() === "other")
    ? "Other (write an answer)"
    : "Other";
}
