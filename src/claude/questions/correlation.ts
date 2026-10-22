/**
 * Match ID-less native completion metadata to the active request (PRD §4).
 * Identity requires the complete ordered question list: count, prompt, header,
 * selection mode, and ordered option labels/descriptions. Any mismatch is a
 * different request; matching only a prompt or a subset cannot establish ownership.
 */
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

/** PermissionRequest can mirror PreToolUse with a different hook ID for the same input. */
export function matchesCandidateHook(
  candidate:
    | { readonly nativeKey: string; readonly questions: readonly QuestionDefinition[] }
    | undefined,
  questions: AskUserQuestionInput["questions"],
  toolUseId: unknown,
  hookEventName: unknown,
): boolean {
  const matchesCandidateQuestions =
    candidate !== undefined && matchesNativeQuestions(questions, candidate.questions);
  const matchesCandidateIdentity =
    typeof toolUseId !== "string" ||
    toolUseId === candidate?.nativeKey ||
    hookEventName === "PermissionRequest";
  return matchesCandidateQuestions && matchesCandidateIdentity;
}
