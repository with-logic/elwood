/**
 * Summarizes a committed Claude transcript record into activity-ready items.
 * Implements PRD §5.4 (C-CLAUDE-15): assistant text, tool calls, and tool
 * results are sourced from the committed transcript, never from ghost-text.
 */

export type ClaudeTranscriptSummary = {
  readonly kind: "assistant_message" | "tool_call" | "tool_result" | "user_message" | "other";
  readonly label: string;
  readonly text?: string;
  readonly toolName?: string;
  readonly toolUseId?: string;
  readonly toolInput?: string;
  readonly toolOutput?: string;
};

/**
 * Expands one transcript record into zero or more summaries. A Claude record is
 * an Anthropic Messages-API turn (`{ type, message: { role, content } }`); its
 * `content` is an array of typed blocks (`text`, `tool_use`, `tool_result`).
 * Only committed roles produce activity — a record with no usable block yields
 * an empty list, so non-message records (mode, snapshots) are silently skipped.
 */
export function summarizeClaudeRecord(item: unknown): readonly ClaudeTranscriptSummary[] {
  const record = asRecord(item);
  const type = stringValue(record["type"]);
  if (type !== "assistant" && type !== "user") return [];
  const message = asRecord(record["message"]);
  const content = message["content"];
  if (typeof content === "string") return [messageSummary(type, content)];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => summarizeBlock(type, block));
}

function summarizeBlock(role: string, block: unknown): readonly ClaudeTranscriptSummary[] {
  const record = asRecord(block);
  const type = stringValue(record["type"]);
  if (type === "text") {
    const text = stringValue(record["text"]);
    return text ? [messageSummary(role, text)] : [];
  }
  if (type === "tool_use") return [toolCall(record)];
  if (type === "tool_result") return [toolResult(record)];
  return [];
}

function messageSummary(role: string, text: string): ClaudeTranscriptSummary {
  const kind = role === "assistant" ? "assistant_message" : "user_message";
  return { kind, label: role, text };
}

function toolCall(block: Record<string, unknown>): ClaudeTranscriptSummary {
  const name = stringValue(block["name"]) ?? "tool";
  return {
    kind: "tool_call",
    label: name,
    toolName: name,
    ...optional("toolUseId", stringValue(block["id"])),
    ...optional("toolInput", stringify(block["input"])),
  };
}

function toolResult(block: Record<string, unknown>): ClaudeTranscriptSummary {
  const id = stringValue(block["tool_use_id"]) ?? "tool";
  return {
    kind: "tool_result",
    label: id,
    toolUseId: id,
    ...optional("toolOutput", stringify(block["content"])),
  };
}

function optional<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}

export function stringify(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
