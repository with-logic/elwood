/**
 * Normalized metadata extraction for unified activity events.
 * Implements PRD §5.4.
 */

import type { ClaudeHookEvent } from "../../claude/hooks/index.ts";
import type { CodexHookEvent } from "../../codex/hooks/index.ts";
import type { CodexTranscriptEvent } from "../../codex/transcript/index.ts";
import { stringify } from "../serialize.ts";
import type { ElwoodActivityEvent, ElwoodAgentKind } from "./index.ts";

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
  // `toolInput` is the SAME unwrapped command the summary already extracted (the bare
  // command, not the CLI's JS/JSON harness), so both surfaces agree and the unwrap
  // logic has one home in the summarizer; it falls back to a generic serialization of
  // the raw `input`/`arguments` only when the summary carried no text (C-CODEX-19).
  if (event.summary.kind === "tool_call") {
    const command = event.summary.text ?? stringify(payload["input"] ?? payload["arguments"]);
    return optional("toolInput", command);
  }
  if (event.summary.kind === "tool_result") {
    // Reuse the text the summarizer already extracted (as `tool_call` above does) instead of
    // re-running `toolOutputText` over the same structured payload; fall back to a generic
    // serialization only when the summary carried none (C-CODEX-19).
    return optional("toolOutput", event.summary.text ?? stringify(payload["output"]));
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
