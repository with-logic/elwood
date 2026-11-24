/** Recognize native Claude user records eligible for prompt text recovery (PRD §5.4). */
import { hasPromptText } from "../../core/activity/prompt-text.ts";
import { isRecord } from "../../core/predicates.ts";

function userContent(item: unknown): unknown {
  if (!isRecord(item) || item["type"] !== "user" || item["isMeta"] === true) return undefined;
  const message = item["message"];
  if (!isRecord(message) || (message["role"] !== undefined && message["role"] !== "user")) {
    return undefined;
  }
  return message["content"];
}

export function userPromptText(item: unknown): string | undefined {
  const content = userContent(item);
  if (typeof content === "string") return hasPromptText(content) ? content : undefined;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block) || block["type"] === "tool_result") return undefined;
    if (block["type"] === "text" && typeof block["text"] === "string") parts.push(block["text"]);
  }
  const text = parts.join("\n");
  return hasPromptText(text) ? text : undefined;
}
