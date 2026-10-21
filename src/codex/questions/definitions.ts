/** Normalize native Codex question capabilities (PRD §7A.5, C-QUESTION-01). */
import { isRecord } from "../../core/predicates.ts";
import type { QuestionDefinition } from "../../core/questions/types.ts";

export type NativeQuestion = {
  readonly nativeId: string;
  readonly definition: QuestionDefinition;
};
const modalOther = {
  label: "None of the above",
  description: "Optionally, add details in notes (tab)",
};
export function parseQuestions(
  value: unknown,
  queued: boolean,
): readonly NativeQuestion[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const result: NativeQuestion[] = [];
  for (const [index, item] of value.entries()) {
    const question = parseQuestion(item, index, queued);
    if (!question) return undefined;
    result.push(question);
  }
  return result;
}
function parseQuestion(item: unknown, index: number, queued: boolean): NativeQuestion | undefined {
  if (!isRecord(item)) return undefined;
  const prompt = queued ? item["title"] : item["question"];
  if (typeof prompt !== "string" || !prompt.trim() || item["isSecret"] === true) return undefined;
  const options = parseOptions(item["options"], queued);
  if (!(options && validNativeId(item, queued, options.length))) return undefined;
  const header = item["header"];
  return {
    nativeId: queued ? String(index) : String(item["id"]),
    definition: {
      prompt,
      ...(typeof header === "string" ? { header } : {}),
      options: queued ? options : [...options, modalOther],
      selection: options.length > 0 ? "single" : "none",
      textMode: queued ? "alternative" : "additional",
      secret: false,
    },
  };
}
function parseOptions(value: unknown, queued: boolean): QuestionDefinition["options"] | undefined {
  if (queued && (value === undefined || value === null)) return [];
  if (!Array.isArray(value)) return undefined;
  if (queued) {
    if (value.length === 0) return undefined;
    if (!value.every((option) => typeof option === "string" && option.trim())) return undefined;
    return value
      .slice(0, 32)
      .filter((label: string) => Buffer.byteLength(label) <= 512)
      .map((label: string) => ({ label }));
  }
  const result: { label: string; description?: string }[] = [];
  for (const option of value) {
    if (!isRecord(option) || typeof option["label"] !== "string" || !option["label"].trim())
      return undefined;
    const description = option["description"];
    result.push({
      label: option["label"],
      ...(typeof description === "string" ? { description } : {}),
    });
  }
  return result;
}

function validNativeId(
  item: Record<string, unknown>,
  queued: boolean,
  optionCount: number,
): boolean {
  return queued || (optionCount > 0 && typeof item["id"] === "string");
}
