/**
 * The simplified, stable public event union yielded by the ergonomic `stream` API,
 * and the mapping from the richer internal `ElwoodActivityEvent` (PRD §5.8, C-API-48).
 * `stream` yields only a turn's CONTENT — assistant text, thinking, tool calls/results —
 * never lifecycle/hook/warning telemetry, which stays on the underlying session events.
 */

import type { ElwoodActivityEvent } from "../activity/index.ts";

/** A simplified turn event surfaced by `stream` (a stable facade over activity kinds). */
export type TurnEvent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "thinking"; readonly text: string }
  | {
      readonly type: "tool_call";
      readonly name: string;
      readonly input?: string;
      readonly toolCallId?: string;
    }
  | {
      readonly type: "tool_result";
      readonly name?: string;
      readonly output?: string;
      readonly toolCallId?: string;
    };

/**
 * Maps an internal activity event to a simplified turn event, or `undefined` for kinds
 * that are NOT turn content (lifecycle, hook, warning, attention, status, …). Only the
 * four content kinds cross the facade boundary, keeping the public union stable.
 */
export function toTurnEvent(event: ElwoodActivityEvent): TurnEvent | undefined {
  switch (event.kind) {
    case "assistant_message":
      return { type: "text", text: event.text ?? "" };
    case "reasoning":
      return { type: "thinking", text: event.text ?? "" };
    case "tool_call":
      return {
        type: "tool_call",
        name: event.toolName ?? event.label,
        ...(event.toolInput === undefined ? {} : { input: event.toolInput }),
        ...(event.toolUseId === undefined ? {} : { toolCallId: event.toolUseId }),
      };
    case "tool_result":
      return {
        type: "tool_result",
        ...(event.toolName === undefined ? {} : { name: event.toolName }),
        ...(event.toolOutput === undefined ? {} : { output: event.toolOutput }),
        ...(event.toolUseId === undefined ? {} : { toolCallId: event.toolUseId }),
      };
    default:
      return undefined;
  }
}

/** UTF-8 byte length of a string (agent text may be multibyte; `.length` counts code units). */
function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** UTF-8 payload size (bytes) of a turn event, for the gate's pending-byte high-water mark. */
export function turnEventBytes(event: TurnEvent): number {
  switch (event.type) {
    case "text":
    case "thinking":
      return utf8Bytes(event.text);
    case "tool_call":
      return (
        utf8Bytes(event.name) +
        (event.input === undefined ? 0 : utf8Bytes(event.input)) +
        (event.toolCallId === undefined ? 0 : utf8Bytes(event.toolCallId))
      );
    case "tool_result":
      return (
        (event.name === undefined ? 0 : utf8Bytes(event.name)) +
        (event.output === undefined ? 0 : utf8Bytes(event.output)) +
        (event.toolCallId === undefined ? 0 : utf8Bytes(event.toolCallId))
      );
  }
}
