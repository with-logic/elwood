/** Read committed native requests and acceptance evidence for PRD §4 adapters. */
import { isRecord } from "../../core/predicates.ts";
import {
  type ModalNativeQuestion,
  parseQuestions,
  type QueuedNativeQuestion,
} from "./definitions.ts";
import { checkQuestionArguments } from "./limits.ts";

export { payloadOf } from "../transcript/payload.ts";

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
export function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
const asyncQuestionToolName = "request_user_input_async";

/** Recognize native envelopes even when their question definitions are unsupported. */
export function questionEnvelope(
  payload: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (payload["type"] === "function_call")
    return payload["name"] === "request_user_input" || payload["name"] === asyncQuestionToolName
      ? payload
      : undefined;
  const item = payload["type"] === "item_completed" ? payload["item"] : payload;
  return isRecord(item) &&
    nativeMessage(item) &&
    item["delivery"] === "async" &&
    Array.isArray(item["questions"])
    ? item
    : undefined;
}
/** Read modal/async function calls and accepted async assistant-message mirrors.
 * Unsupported records within the metadata budget return undefined.
 * @throws QuestionLimitError for raw-argument or decoded question-metadata limit violations. */
export function questionCall(payload: Record<string, unknown>): QuestionCall | undefined {
  const envelope = questionEnvelope(payload);
  if (!envelope) return undefined;
  if (envelope["type"] === "function_call") {
    const name = envelope["name"];
    checkQuestionArguments(envelope["arguments"], envelope["call_id"]);
    const argumentsValue = jsonRecord(envelope["arguments"]);
    return parsedCall(envelope["call_id"], argumentsValue?.["questions"], {
      queued: name === asyncQuestionToolName,
      accepted: false,
    });
  }
  if (!hasAsyncQuestionMetadata(envelope)) return undefined;
  return parsedCall(envelope["id"], envelope["questions"], { queued: true, accepted: true });
}
function nativeMessage(item: Record<string, unknown>): boolean {
  return (
    item["type"] === "AgentMessage" ||
    item["type"] === "agent_message" ||
    (item["type"] === "message" && item["role"] === "assistant")
  );
}
function parsedCall(
  callId: unknown,
  value: unknown,
  { queued, accepted }: { readonly queued: boolean; readonly accepted: boolean },
): QuestionCall | undefined {
  const budgetCallId = typeof callId === "string" ? callId : "";
  if (queued) {
    const questions = parseQuestions(value, true, budgetCallId);
    if (typeof callId !== "string" || !callId) return undefined;
    return questions ? { callId, queued: true, accepted, questions } : undefined;
  }
  const questions = parseQuestions(value, false, budgetCallId);
  if (typeof callId !== "string" || !callId) return undefined;
  return questions ? { callId, queued: false, accepted: false, questions } : undefined;
}
export function hasAsyncQuestionMetadata(item: Record<string, unknown>): boolean {
  return (
    item["delivery"] === "async" && Array.isArray(item["questions"]) && item["questions"].length > 0
  );
}
const questionReplyOpen = "<send_user_message_question_reply>";
const questionReplyClose = "</send_user_message_question_reply>";

/** Native questionItemId identifies the queued item, not an Elwood question or tool call. */
export type QuestionReply = { readonly questionItemId: string; readonly answer: string };
export function questionReplies(payload: Record<string, unknown>): readonly QuestionReply[] {
  if (
    payload["type"] !== "message" ||
    payload["role"] !== "user" ||
    !Array.isArray(payload["content"])
  )
    return [];
  const repliesFound: QuestionReply[] = [];
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
      // Reject this entire content part if any member is malformed; other parts are independent.
      if (!replies.every(validReply)) continue;
      for (const reply of replies) repliesFound.push(reply);
    } catch {
      /* Malformed user prose is not native acceptance. */
    }
  }
  return repliesFound;
}
export function queuedKey(callId: string, index: number): string {
  return JSON.stringify([asyncQuestionToolName, callId, index]);
}

function validReply(reply: unknown): reply is QuestionReply {
  return (
    isRecord(reply) &&
    typeof reply["questionItemId"] === "string" &&
    typeof reply["answer"] === "string"
  );
}
