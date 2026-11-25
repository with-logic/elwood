/** Each kind of native question round a Claude proof session can run (PRD §12, C-E2E-18). */
import type { ElwoodQuestionRequest } from "../../../src/index.ts";
import {
  checkboxFinal,
  checkboxPrompt,
  groupedFinal,
  groupedPrompt,
  textFinal,
  textPrompt,
} from "./claude-cases.ts";
import type { claudeQuestionRounds } from "./claude-round.ts";

export type ClaudeRoundKind = "grouped" | "text" | "checkbox";

/** The native option IDs for these labels, in the given order. */
function optionIds(
  question: ElwoodQuestionRequest["questions"][number],
  labels: readonly string[],
): readonly string[] {
  return labels.map((label) => {
    const option = question.options.find((item) => item.label === label);
    if (!option) throw new Error(`Native option ${label} must be present`);
    return option.id;
  });
}

/**
 * `claudeQuestionRounds` runs any one round; this gives each kind its prompt, its answer and the
 * native answers it expects. Each runner returns the answered request ID.
 */
export function claudeRoundsByKind(
  round: ReturnType<typeof claudeQuestionRounds>,
  note: string,
): Readonly<Record<ClaudeRoundKind, () => Promise<string>>> {
  return {
    grouped: () =>
      round(
        groupedPrompt,
        (request) =>
          request.questions.map((question) => ({
            questionId: question.id,
            optionIds: optionIds(
              question,
              question.header === "Color" ? ["Blue"] : ["Logging", "Metrics"],
            ),
          })),
        { "Which test color?": "Blue", "Which test features?": "Logging, Metrics" },
        groupedFinal,
      ),
    text: () =>
      round(
        textPrompt,
        (request) => request.questions.map((question) => ({ questionId: question.id, text: note })),
        { "Which test note?": note },
        textFinal,
      ),
    checkbox: () =>
      round(
        checkboxPrompt,
        (request) =>
          request.questions.map((question) => ({
            questionId: question.id,
            optionIds: optionIds(question, ["Apple", "Cherry"]),
          })),
        { "Which test fruits?": "Apple, Cherry" },
        checkboxFinal,
      ),
  };
}
