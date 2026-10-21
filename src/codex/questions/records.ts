/** Read committed native requests and acceptance evidence for PRD §4 adapters. */
import { isRecord } from "../../core/predicates.ts";
import {
  type ModalNativeQuestion,
  parseQuestions,
  type QueuedNativeQuestion,
} from "./definitions.ts";
import { checkQuestionArguments } from "./limits.ts";

export type QuestionCall = { readonly callId: string } & (
  | {
      readonly queued: false;
      readonly accepted: false;
      readonly questions: readonly ModalNativeQuestion[];
    }
  | {
      readonly queued: true;
      readonly accepted: boolean;
      readonly questions: readonly QueuedNativeQuestion[];
    }
);
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
  if (!(isRecord(item) && nativeMessage(item) && hasAsyncQuestionMetadata(item))) return undefined;
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
  const identity = typeof id === "string" ? id : "";
  if (queued) {
    const questions = parseQuestions(value, true, identity);
    if (typeof id !== "string" || !id) return undefined;
    return questions ? { callId: id, queued: true, accepted, questions } : undefined;
  }
  const questions = parseQuestions(value, false, identity);
  if (typeof id !== "string" || !id) return undefined;
  return questions ? { callId: id, queued: false, accepted: false, questions } : undefined;
}
export function hasAsyncQuestionMetadata(item: Record<string, unknown>): boolean {
  return (
    item["delivery"] === "async" && Array.isArray(item["questions"]) && item["questions"].length > 0
  );
}
const questionReplyOpen = "<send_user_message_question_reply>";
const questionReplyClose = "</send_user_message_question_reply>";

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
    const text = part["text"];
    if (!(text.startsWith(questionReplyOpen) && text.endsWith(questionReplyClose))) continue;
    try {
      const replies: unknown = JSON.parse(
        text.slice(questionReplyOpen.length, -questionReplyClose.length).trim(),
      );
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
