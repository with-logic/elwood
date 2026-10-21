/** Normalize native Codex question capabilities for the PRD §4 adapter boundary. */
import { isRecord } from "../../core/predicates.ts";
import type { QuestionDefinition } from "../../core/questions/types.ts";
import { checkQuestionInput } from "./limits.ts";

export type NativeQuestion = { readonly definition: QuestionDefinition } & (
  | { readonly nativeId: string; readonly questionIndex?: never }
  | { readonly questionIndex: number; readonly nativeId?: never }
);
// Codex limits queued suggestions before rendering its native question editor.
const queuedOptionCountLimit = 32;
const queuedOptionLabelLimitBytes = 512;
const modalOther = {
  label: "None of the above",
  description: "Optionally, add details in notes (tab)",
};
export function parseQuestions(
  value: unknown,
  queued: boolean,
  identity = "",
): readonly NativeQuestion[] | undefined {
  checkQuestionInput(value, identity);
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const result: NativeQuestion[] = [];
  const nativeIds = new Set<string>();
  for (const [index, item] of value.entries()) {
    const question = parseQuestion(item, index, queued);
    if (!question) return undefined;
    if (question.nativeId !== undefined) {
      if (nativeIds.has(question.nativeId)) return undefined;
      nativeIds.add(question.nativeId);
    }
    result.push(question);
  }
  return result;
}
function parseQuestion(item: unknown, index: number, queued: boolean): NativeQuestion | undefined {
  if (!isRecord(item)) return undefined;
  const prompt = queued ? item["title"] : item["question"];
  if (typeof prompt !== "string" || !prompt.trim()) return undefined;
  if ("isSecret" in item && item["isSecret"] !== false) return undefined;
  const options = parseOptions(item["options"], queued);
  if (!(options && validNativeId(item, queued, options.length))) return undefined;
  const header = item["header"];
  return {
    ...(queued ? { questionIndex: index } : { nativeId: String(item["id"]) }),
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
      .slice(0, queuedOptionCountLimit)
      .filter((label: string) => Buffer.byteLength(label) <= queuedOptionLabelLimitBytes)
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
