/** Nested concrete Claude tool value predicates, implementing PRD §6.4. */

import { isOneOf, isRecord, optionalBoolean, optionalString } from "../../core/predicates.ts";

export function optionalOutputMode(value: unknown): boolean {
  return value === undefined || isOneOf(value, ["content", "files_with_matches", "count"]);
}

export function isQuestions(value: unknown): boolean {
  return Array.isArray(value) && value.every(isQuestion);
}

function isQuestion(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value["question"] === "string" &&
    typeof value["header"] === "string" &&
    Array.isArray(value["options"]) &&
    value["options"].every(isQuestionOption) &&
    optionalBoolean(value["multiSelect"])
  );
}

function isQuestionOption(value: unknown): boolean {
  return (
    isRecord(value) && typeof value["label"] === "string" && optionalString(value["description"])
  );
}

export function optionalAnswers(value: unknown): boolean {
  return (
    value === undefined ||
    (isRecord(value) && Object.values(value).every((entry) => typeof entry === "string"))
  );
}

export function optionalAllowedPrompts(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every(isAllowedPrompt));
}

function isAllowedPrompt(value: unknown): boolean {
  return isRecord(value) && value["tool"] === "Bash" && typeof value["prompt"] === "string";
}
