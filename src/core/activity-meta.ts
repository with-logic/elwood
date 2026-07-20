/**
 * Normalized metadata extraction for unified activity events.
 * Implements PRD §5.4.
 */

import type { ClaudeHookEvent } from "../claude/hooks.ts";
import type { CodexHookEvent } from "../codex/hooks.ts";
import { type CodexTranscriptEvent, toolOutputText } from "../codex/transcript.ts";
import type { ElwoodActivityEvent, ElwoodAgentKind } from "./activity.ts";
import { stringify } from "./serialize.ts";

export function hookActivityBase(
  agent: ElwoodAgentKind,
  elwoodSessionId: string,
  event: ClaudeHookEvent | CodexHookEvent,
): Omit<ElwoodActivityEvent, "kind" | "label" | "text"> {
  const source = record(event);
  return {
    elwoodSessionId,
    agent,
    source: "hook",
    hookEventName: event.hook_event_name,
    ...optional("turnId", stringValue(source["turn_id"])),
    ...optional("toolName", stringValue(source["tool_name"])),
    ...optional("toolUseId", stringValue(source["tool_use_id"])),
    raw: event,
  };
}

export function transcriptActivityMeta(event: CodexTranscriptEvent): Partial<ElwoodActivityEvent> {
  const item = record(event.item);
  const payload = record(item["payload"]);
  return {
    transcriptPath: event.path,
    ...optional("turnId", stringValue(item["turn_id"]) ?? stringValue(payload["turn_id"])),
    ...optional("toolName", transcriptToolName(event, payload)),
    ...optional("toolUseId", transcriptToolUseId(event, payload)),
    ...transcriptToolIo(event, payload),
  };
}

function transcriptToolIo(
  event: CodexTranscriptEvent,
  payload: Record<string, unknown>,
): Partial<ElwoodActivityEvent> {
  // A `custom_tool_call` (modern `exec`) carries its command in `input`; a
  // `function_call` in JSON `arguments`. A `tool_result`'s output is a plain string
  // or an `input_text[]` array — surface the array's joined readable text, falling
  // back to a generic serialization for any other shape (C-CODEX-19).
  if (event.summary.kind === "tool_call") {
    return optional("toolInput", stringify(payload["input"] ?? payload["arguments"]));
  }
  if (event.summary.kind === "tool_result") {
    const output = payload["output"];
    return optional("toolOutput", toolOutputText(output) ?? stringify(output));
  }
  return {};
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function transcriptToolName(
  event: CodexTranscriptEvent,
  payload: Record<string, unknown>,
): string | undefined {
  if (event.summary.kind !== "tool_call") return undefined;
  return stringValue(payload["name"]) ?? event.summary.label;
}

function transcriptToolUseId(
  event: CodexTranscriptEvent,
  payload: Record<string, unknown>,
): string | undefined {
  if (event.summary.kind !== "tool_call" && event.summary.kind !== "tool_result") return undefined;
  return stringValue(payload["id"]) ?? stringValue(payload["call_id"]) ?? event.summary.label;
}

function optional<K extends keyof ElwoodActivityEvent>(
  key: K,
  value: ElwoodActivityEvent[K] | undefined,
): Partial<ElwoodActivityEvent> {
  return value === undefined ? {} : { [key]: value };
}
