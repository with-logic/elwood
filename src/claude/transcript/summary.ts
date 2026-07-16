/**
 * Summarizes a committed Claude transcript record into activity-ready items.
 * Implements PRD §5.4 (C-CLAUDE-15): assistant text, tool calls, and tool
 * results are sourced from the committed transcript, never from ghost-text.
 */

import { stringify } from "../../core/serialize.ts";

/**
 * A committed transcript item, discriminated by kind so each variant carries
 * only the fields it can have (an `assistant_message` always has `text`; a
 * `tool_call` always has `toolName`; a `tool_result` always has `toolUseId`).
 */
export type ClaudeTranscriptSummary =
  | { readonly kind: "assistant_message"; readonly label: string; readonly text: string }
  | { readonly kind: "reasoning"; readonly label: string; readonly text: string }
  | {
      readonly kind: "tool_call";
      readonly label: string;
      readonly toolName: string;
      readonly toolUseId?: string;
      readonly toolInput?: string;
    }
  | {
      readonly kind: "tool_result";
      readonly label: string;
      readonly toolUseId: string;
      readonly toolOutput?: string;
    };

/** The committed roles a Claude transcript record can carry. */
type ClaudeTranscriptRole = "assistant" | "user";

/**
 * Expands one transcript record into zero or more summaries. A Claude record is
 * an Anthropic Messages-API turn (`{ type, message: { role, content } }`) whose
 * `content` is `text` / `tool_use` / `tool_result` blocks. Only committed
 * ASSISTANT text and tool calls/results become activity (C-CLAUDE-15): user
 * prose stays hook-sourced from `UserPromptSubmit`, so it is NOT emitted here
 * (that would double every submitted prompt). Non-message records yield nothing.
 */
export function summarizeClaudeRecord(item: unknown): readonly ClaudeTranscriptSummary[] {
  const record = asRecord(item);
  const type = stringValue(record["type"]);
  if (type !== "assistant" && type !== "user") return [];
  const role: ClaudeTranscriptRole = type;
  const content = asRecord(record["message"])["content"];
  if (typeof content === "string") return assistantText(role, content);
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => summarizeBlock(role, block));
}

function summarizeBlock(
  role: ClaudeTranscriptRole,
  block: unknown,
): readonly ClaudeTranscriptSummary[] {
  const record = asRecord(block);
  const type = stringValue(record["type"]);
  if (type === "text") return assistantText(role, stringValue(record["text"]) ?? "");
  if (type === "thinking") return reasoning(role, stringValue(record["thinking"]) ?? "");
  if (type === "tool_use") return [toolCall(record)];
  if (type === "tool_result") return [toolResult(record)];
  // `redacted_thinking` carries only an opaque encrypted `data` blob (no readable
  // text), so it is dropped here alongside any other unknown block type.
  return [];
}

/**
 * Extended-thinking prose from an assistant `thinking` block (C-CLAUDE-15). Like
 * assistant text, only ASSISTANT reasoning is surfaced and empty thinking is
 * dropped. The plaintext is committed to the transcript by the CLI, so it needs no
 * hook and is surfaced as a `reasoning` activity — mirroring Codex (§5.4, §7A.4).
 */
function reasoning(role: ClaudeTranscriptRole, text: string): readonly ClaudeTranscriptSummary[] {
  if (role !== "assistant" || text.length === 0) return [];
  return [{ kind: "reasoning", label: "thinking", text }];
}

/** Assistant prose only: user text is intentionally dropped (hook-sourced). */
function assistantText(
  role: ClaudeTranscriptRole,
  text: string,
): readonly ClaudeTranscriptSummary[] {
  if (role !== "assistant" || text.length === 0) return [];
  return [{ kind: "assistant_message", label: role, text }];
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
