/**
 * Projects one committed Codex JSONL transcript item into a bounded summary.
 * Implements PRD §7A.4 (C-API-12, C-CODEX-18, C-CODEX-19): assistant messages,
 * tool calls/results, reasoning summary text, and web searches are surfaced; raw
 * encrypted reasoning is never surfaced.
 */

import type { CodexTranscriptSummary } from "./types.ts";

export function summarizeTranscriptItem(item: unknown): CodexTranscriptSummary {
  const payload = record(record(item)?.["payload"]);
  if (!payload) {
    return { kind: "other", label: stringValue(record(item)?.["type"]) ?? "unknown" };
  }
  const type = stringValue(payload?.["type"]);
  if (type === "web_search_end" || type === "web_search_call") return webSearch(payload);
  if (type === "function_call") return toolCall(payload);
  if (type === "custom_tool_call") return toolCall(payload);
  if (type === "function_call_output") return toolResult(payload);
  if (type === "custom_tool_call_output") return toolResult(payload);
  if (type === "reasoning") return reasoning(payload);
  if (type === "message") return message(payload);
  if (type === "agent_message") return agentMessage(payload);
  return { kind: "other", label: type ?? stringValue(record(item)?.["type"]) ?? "unknown" };
}

function webSearch(payload: Record<string, unknown>): CodexTranscriptSummary {
  const query = stringValue(payload["query"]);
  const action = record(payload["action"]);
  const actionType = stringValue(action?.["type"]) ?? "search";
  const textValue = query ?? stringValue(action?.["url"]) ?? stringValue(action?.["pattern"]);
  return { kind: "web_search", label: actionType, ...(text(textValue) ?? {}) };
}

// A `custom_tool_call` (modern `exec`) carries its command in `input`; a
// `function_call` in JSON `arguments` — surface whichever holds it, UNWRAPPED from
// the CLI's JS/JSON harness so consumers see the bare command (C-CODEX-19).
function toolCall(payload: Record<string, unknown>): CodexTranscriptSummary {
  const name = stringValue(payload["name"]) ?? "tool";
  const raw = payload["input"] ?? payload["arguments"];
  const command = typeof raw === "string" ? extractCommand(raw) : undefined;
  return { kind: "tool_call", label: name, ...(text(command ?? raw) ?? {}) };
}

// Unwrap a Codex exec invocation to the bare command. The modern `exec` tool sends
// a JS snippet `... tools.exec_command({"cmd":"...", ...}) ...`; older function calls
// send JSON `arguments` like `{"command":["bash","-lc","..."]}` or `{"cmd":"..."}`.
// Pull the FIRST embedded JSON object, then read its command; fall back to the raw
// string when nothing parses so a command is never lost (C-CODEX-19).
function extractCommand(input: string): string | undefined {
  const args = firstJsonObject(input);
  if (!args) return undefined;
  const command = args["command"] ?? args["cmd"];
  if (typeof command === "string") return command;
  if (Array.isArray(command))
    return command.every((part) => typeof part === "string") ? command.join(" ") : undefined;
  return undefined;
}

// Extract and parse the first balanced `{...}` object literal in a string. Codex's
// exec `cmd` values can themselves contain braces, so scan for a brace-balanced span
// (respecting string literals/escapes) rather than a greedy regex.
function firstJsonObject(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}" && --depth === 0) return safeJsonRecord(text.slice(start, i + 1));
  }
  return undefined;
}

function safeJsonRecord(json: string): Record<string, unknown> | undefined {
  try {
    return record(JSON.parse(json));
  } catch {
    return undefined;
  }
}

function toolResult(payload: Record<string, unknown>): CodexTranscriptSummary {
  const callId = stringValue(payload["call_id"]) ?? "tool";
  return { kind: "tool_result", label: callId, ...(text(toolOutputText(payload["output"])) ?? {}) };
}

// A tool result's output is a plain string, or an `{ type:"input_text", text }[]`
// array (custom_tool_call_output/modern exec) whose text is joined; else nothing
// (caller falls back to generic serialization) (C-CODEX-19).
export function toolOutputText(output: unknown): string | undefined {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return undefined;
  const parts = output
    .map((entry) => stringValue(record(entry)?.["text"]))
    .filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join("") : undefined;
}

function message(payload: Record<string, unknown>): CodexTranscriptSummary {
  const role = stringValue(payload["role"]) ?? "message";
  return { kind: "message", label: role, ...(text(payload["content"]) ?? {}) };
}

function agentMessage(payload: Record<string, unknown>): CodexTranscriptSummary {
  return { kind: "message", label: "assistant", ...(text(payload["message"]) ?? {}) };
}

// A Codex reasoning item: readable text is `summary[]` `summary_text` entries, or
// (rarely) `content[]` `reasoning_text`; `encrypted_content` is never surfaced.
// Most items have an empty summary, so `text` is set only when prose exists (§7A.4).
function reasoning(payload: Record<string, unknown>): CodexTranscriptSummary {
  const value =
    reasoningText(payload["summary"], "summary_text") ??
    reasoningText(payload["content"], "reasoning_text");
  return { kind: "reasoning", label: "reasoning", ...(text(value) ?? {}) };
}

/** Join the `text` of every array entry whose `type` matches; undefined if none. */
function reasoningText(value: unknown, entryType: string): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts = value
    .filter((e) => stringValue(record(e)?.["type"]) === entryType)
    .map((e) => stringValue(record(e)?.["text"]))
    .filter((part): part is string => part !== undefined && part.length > 0);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function text(value: unknown): { readonly text: string } | undefined {
  if (typeof value === "string") return { text: value };
  return undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
