/** Read committed native requests and acceptance evidence (PRD §7A.5). */
import { isRecord } from "../../core/predicates.ts";
import { type NativeQuestion, parseQuestions } from "./definitions.ts";
import { checkQuestionArguments, checkQuestionInput } from "./limits.ts";

export type QuestionCall = {
  readonly callId: string;
  readonly queued: boolean;
  readonly accepted: boolean;
  readonly questions: readonly NativeQuestion[];
};
export function payloadOf(item: unknown): Record<string, unknown> | undefined {
  return isRecord(item) && isRecord(item["payload"]) ? item["payload"] : undefined;
}
export function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
export function questionCall(payload: Record<string, unknown>): QuestionCall | undefined {
  if (payload["type"] === "function_call") {
    const name = payload["name"];
    if (name !== "request_user_input" && name !== "request_user_input_async") return undefined;
    checkQuestionArguments(payload["arguments"], payload["call_id"]);
    const argumentsValue = jsonRecord(payload["arguments"]);
    return parsedCall(
      payload["call_id"],
      name === "request_user_input_async",
      false,
      argumentsValue?.["questions"],
    );
  }
  const item = payload["type"] === "item_completed" ? payload["item"] : payload;
  if (!(isRecord(item) && nativeMessage(item) && isAsyncQuestionMessage(item))) return undefined;
  return parsedCall(item["id"], true, true, item["questions"]);
}
function nativeMessage(item: Record<string, unknown>): boolean {
  return (
    item["type"] === "AgentMessage" ||
    item["type"] === "agent_message" ||
    (item["type"] === "message" && item["role"] === "assistant")
  );
}
function parsedCall(
  id: unknown,
  queued: boolean,
  accepted: boolean,
  value: unknown,
): QuestionCall | undefined {
  checkQuestionInput(value, typeof id === "string" ? id : "");
  if (typeof id !== "string" || !id) return undefined;
  const questions = parseQuestions(value, queued);
  return questions ? { callId: id, queued, accepted, questions } : undefined;
}
/** Metadata-bearing native async messages are never final answers, including legacy mirrors. */
export function isAsyncQuestionMessage(item: Record<string, unknown>): boolean {
  return (
    item["delivery"] === "async" && Array.isArray(item["questions"]) && item["questions"].length > 0
  );
}
export function answeredQuestionIds(payload: Record<string, unknown>): readonly string[] {
  if (
    payload["type"] !== "message" ||
    payload["role"] !== "user" ||
    !Array.isArray(payload["content"])
  )
    return [];
  const ids: string[] = [];
  for (const part of payload["content"]) {
    if (!isRecord(part) || part["type"] !== "input_text" || typeof part["text"] !== "string")
      continue;
    const match =
      /^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>$/.exec(
        part["text"],
      );
    if (!match) continue;
    try {
      const replies: unknown = JSON.parse(match[1]!);
      if (!Array.isArray(replies)) continue;
      for (const reply of replies) {
        if (
          isRecord(reply) &&
          typeof reply["questionItemId"] === "string" &&
          typeof reply["answer"] === "string"
        )
          ids.push(reply["questionItemId"]);
      }
    } catch {
      /* Malformed user prose is not native acceptance. */
    }
  }
  return ids;
}
export function queuedKey(callId: string, index: number): string {
  return JSON.stringify(["request_user_input_async", callId, index]);
}
