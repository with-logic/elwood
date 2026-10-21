/** Decode canonical native question calls and committed answer envelopes (PRD §12). */
import { record } from "../../../src/core/activity/meta.ts";

export type NativeCodexRecord = Readonly<Record<string, unknown>>;

export function nativeCodexPayload(item: unknown): Record<string, unknown> {
  return record(record(item)["payload"]);
}

export function nativeCodexFunctionCalls(records: readonly unknown[], name: string) {
  return records
    .filter((item) => record(item)["type"] === "response_item")
    .map(nativeCodexPayload)
    .filter((payload) => payload["type"] === "function_call" && payload["name"] === name);
}

export function nativeCodexFunctionOutput(
  records: readonly unknown[],
  name: string,
): string | undefined {
  const [call] = nativeCodexFunctionCalls(records, name);
  const output = records
    .filter((item) => record(item)["type"] === "response_item")
    .map(nativeCodexPayload)
    .find(
      (item) => item["type"] === "function_call_output" && item["call_id"] === call?.["call_id"],
    )?.["output"];
  return typeof output === "string" ? output : undefined;
}

/** Keep decoded values unknown until a proof checks its expected envelope shape. */
export function nativeCodexQueuedReplies(records: readonly unknown[]): readonly unknown[] {
  return records.flatMap((item) => {
    const payload = nativeCodexPayload(item);
    if (
      record(item)["type"] !== "response_item" ||
      payload["type"] !== "message" ||
      payload["role"] !== "user"
    )
      return [];
    const content = payload["content"];
    if (!Array.isArray(content)) return [];
    return content.flatMap((part: unknown): unknown[] => {
      const text = record(part)["text"];
      if (typeof text !== "string") return [];
      const match = text.match(
        /^<send_user_message_question_reply>\n(.*)\n<\/send_user_message_question_reply>$/s,
      );
      if (match?.[1] === undefined) return [];
      const decoded: unknown = JSON.parse(match[1]);
      return [decoded];
    });
  });
}
