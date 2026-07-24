/**
 * The simplified, stable public event union yielded by the ergonomic `stream` API,
 * and the mapping from the richer internal `ElwoodActivityEvent` (PRD §5.8, C-API-48).
 * `stream` yields only a turn's CONTENT — assistant text, thinking, tool calls/results —
 * never lifecycle/hook/warning telemetry, which stays on the underlying session events.
 */

import type { ElwoodActivityEvent } from "../activity.ts";

/** A simplified turn event surfaced by `stream` (a stable facade over activity kinds). */
export type TurnEvent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "thinking"; readonly text: string }
  | { readonly type: "tool_call"; readonly name: string; readonly input?: string }
  | { readonly type: "tool_result"; readonly name?: string; readonly output?: string };

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
      };
    case "tool_result":
      return {
        type: "tool_result",
        ...(event.toolName === undefined ? {} : { name: event.toolName }),
        ...(event.toolOutput === undefined ? {} : { output: event.toolOutput }),
      };
    default:
      return undefined;
  }
}
