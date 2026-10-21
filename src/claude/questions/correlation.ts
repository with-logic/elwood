/** Match ID-less native completion metadata to the active request (PRD §4). */
import type { QuestionDefinition } from "../../core/questions/types.ts";
import type { AskUserQuestionInput } from "../hooks/tool-types.ts";

export function matchesNativeQuestions(
  questions: AskUserQuestionInput["questions"],
  definitions: readonly QuestionDefinition[],
): boolean {
  return (
    questions.length === definitions.length &&
    questions.every((question, index) => {
      const definition = definitions[index]!;
      return (
        question.question === definition.prompt &&
        question.header === definition.header &&
        Boolean(question.multiSelect) === (definition.selection === "multiple") &&
        question.options.length === definition.options.length &&
        question.options.every((option, optionIndex) => {
          const current = definition.options[optionIndex]!;
          return option.label === current.label && option.description === current.description;
        })
      );
    })
  );
}
