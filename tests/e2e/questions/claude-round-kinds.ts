/** Each kind of native question round a Claude proof session can run (PRD §12, C-E2E-18). */
import type { ElwoodQuestionRequest } from "../../../src/index.ts";
import {
  checkboxFinal,
  checkboxPrompt,
  type claudeProofTexts,
  groupedFinal,
  groupedPrompt,
  longTextFinal,
  longTextPrompt,
  textFinal,
  textPrompt,
} from "./claude-cases.ts";
import type { claudeQuestionRounds } from "./claude-round.ts";

export type ClaudeRoundKind = "grouped" | "text" | "long-text" | "checkbox";

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
  texts: ReturnType<typeof claudeProofTexts>,
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
        (request) =>
          request.questions.map((question) => ({ questionId: question.id, text: texts.note })),
        { "Which test note?": texts.note },
        textFinal,
      ),
    "long-text": () =>
      round(
        longTextPrompt,
        (request) =>
          request.questions.map((question) => ({
            questionId: question.id,
            text: question.header === "Link" ? texts.link : texts.summary,
          })),
        // Elwood pastes LF line endings; Claude reports the exact pasted text, not its wrapped rows.
        {
          "Which test summary?": texts.summary.replace("\r\n", "\n"),
          "Which test link?": texts.link,
        },
        longTextFinal,
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
