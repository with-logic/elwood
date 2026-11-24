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

function isNonToolResultBlock(block: unknown): block is Readonly<Record<string, unknown>> {
  return isRecord(block) && block["type"] !== "tool_result";
}

function userPromptContent(
  item: unknown,
): string | readonly Readonly<Record<string, unknown>>[] | undefined {
  const content = userContent(item);
  if (typeof content === "string") return content;
  if (Array.isArray(content) && content.length > 0 && content.every(isNonToolResultBlock)) {
    return content;
  }
  return undefined;
}

export function userPromptText(item: unknown): string | undefined {
  const content = userPromptContent(item);
  const text =
    typeof content === "string"
      ? content
      : content
          ?.flatMap((block) =>
            block["type"] === "text" && typeof block["text"] === "string" ? [block["text"]] : [],
          )
          .join("\n");
  return text !== undefined && hasPromptText(text) ? text : undefined;
}
