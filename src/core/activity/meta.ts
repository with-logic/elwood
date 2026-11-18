/**
 * Normalized metadata extraction for unified activity events.
 * Implements PRD §5.4.
 */

import type { ClaudeHookEvent } from "../../claude/hooks/index.ts";
import type { CodexHookEvent } from "../../codex/hooks/index.ts";
import { type CodexTranscriptEvent, toolOutputText } from "../../codex/transcript/index.ts";
import { optional } from "../optional.ts";
import { stringify } from "../serialize.ts";
import type { ElwoodActivityEvent, ElwoodAgentKind } from "./index.ts";

export function hookActivityBase(
  agent: ElwoodAgentKind,
  elwoodSessionId: string,
  event: ClaudeHookEvent | CodexHookEvent,
): Omit<
  ElwoodActivityEvent,
  "kind" | "label" | "text" | "speed" | "tokenUsage" | "rateLimits" | "subagent"
> {
  const source = record(event);
  return {
    elwoodSessionId,
    agent,
    source: "hook",
    hookEventName: event.hook_event_name,
    ...optionalMeta(
      stringValue(source["turn_id"]) ??
        (agent === "claude" ? stringValue(source["prompt_id"]) || undefined : undefined),
      "turnId",
    ),
    ...optionalMeta(stringValue(source["tool_name"]), "toolName"),
    ...optionalMeta(stringValue(source["tool_use_id"]), "toolUseId"),
    raw: event,
  };
}

type OptionalTranscriptMeta = Pick<
  ElwoodActivityEvent,
  "turnId" | "toolName" | "toolUseId" | "toolInput" | "toolOutput"
>;
type TranscriptActivityMeta = OptionalTranscriptMeta & { readonly transcriptPath: string };
const optionalMeta = optional<keyof OptionalTranscriptMeta, string>;

export function transcriptActivityMeta(event: CodexTranscriptEvent): TranscriptActivityMeta {
  const item = record(event.item);
  const payload = record(item["payload"]);
  return {
    transcriptPath: event.path,
    ...optionalMeta(stringValue(item["turn_id"]) ?? stringValue(payload["turn_id"]), "turnId"),
    ...optionalMeta(transcriptToolName(event, payload), "toolName"),
    ...optionalMeta(transcriptToolUseId(event, payload), "toolUseId"),
    ...transcriptToolIo(event, payload),
  };
}

function transcriptToolIo(
  event: CodexTranscriptEvent,
  payload: Record<string, unknown>,
): Pick<ElwoodActivityEvent, "toolInput" | "toolOutput"> {
  // `toolInput` is the SAME unwrapped command the summary already extracted (the bare
  // command, not the CLI's JS/JSON harness), so both surfaces agree and the unwrap
  // logic has one home in the summarizer; it falls back to a generic serialization of
  // the raw `input`/`arguments` only when the summary carried no text (C-CODEX-19).
  if (event.summary.kind === "tool_call") {
    const command = event.summary.text ?? stringify(payload["input"] ?? payload["arguments"]);
    return optionalMeta(command, "toolInput");
  }
  if (event.summary.kind === "tool_result") {
    const output = payload["output"];
    return optionalMeta(toolOutputText(output) ?? stringify(output), "toolOutput");
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
