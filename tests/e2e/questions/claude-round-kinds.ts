/** Each kind of native question round a Claude proof session can run (PRD §12, C-E2E-18). */
import { setTimeout as delay } from "node:timers/promises";
import { claudeDialogInputGraceMs } from "../../../src/claude/dialog-input-grace.ts";
import { arrowDown } from "../../../src/core/input/constants.ts";
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

export type ClaudeRoundKind = "grouped" | "text" | "long-text" | "checkbox" | "prechecked-checkbox";

/** A person at the native terminal: keys that bypass Elwood, and the screen they see. */
export type ClaudeProofPerson = {
  readonly press: (input: string) => void;
  readonly screen: () => string | undefined;
};
const personKeyGapMs = 300;
const personCheckTimeoutMs = 10_000;

/** Checks Cherry at the native terminal, as a person might before Elwood answers. */
async function checkCherry(person: ClaudeProofPerson): Promise<void> {
  // Claude ignores keys pressed before its dialog input grace ends.
  await delay(claudeDialogInputGraceMs);
  for (const key of [arrowDown, arrowDown, " "]) {
    person.press(key);
    await delay(personKeyGapMs);
  }
  const deadline = Date.now() + personCheckTimeoutMs;
  while (!/\[✔\] Cherry/.test(person.screen() ?? "")) {
    if (Date.now() > deadline) throw new Error("Cherry must be checked after the person's keys");
    await delay(100);
  }
}

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
  person: ClaudeProofPerson,
): Readonly<Record<ClaudeRoundKind, () => Promise<string>>> {
  const fruits = (request: ElwoodQuestionRequest) =>
    request.questions.map((question) => ({
      questionId: question.id,
      optionIds: optionIds(question, ["Apple", "Cherry"]),
    }));
  // Claude lists checked labels in check order; Elwood's completion must still be native order.
  const fruitAnswers = { "Which test fruits?": "Apple, Cherry" };
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
    checkbox: () => round(checkboxPrompt, fruits, fruitAnswers, checkboxFinal),
    "prechecked-checkbox": () =>
      round(checkboxPrompt, fruits, fruitAnswers, checkboxFinal, () => checkCherry(person)),
  };
}
