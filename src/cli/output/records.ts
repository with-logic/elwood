/**
 * Projects normalized turn and lifecycle events into the fixed CLI record allowlist.
 * Implements PRD §12A.3 and C-CLI-11/C-CLI-12.
 */

import type { ElwoodActivityEvent } from "../../core/activity.ts";
import type { TurnEvent } from "../../core/simple/events.ts";
import type { ElwoodWarningEvent } from "../../core/types.ts";
import type { CliProgressRecord, CliTextSanitizer } from "./types.ts";

export function progressFromTurn(event: TurnEvent, clean: CliTextSanitizer): CliProgressRecord {
  switch (event.type) {
    case "text":
      return { schemaVersion: 1, type: "text", text: clean(event.text) };
    case "thinking":
      return { schemaVersion: 1, type: "thinking", text: clean(event.text) };
    case "tool_call":
      return {
        schemaVersion: 1,
        type: "tool",
        phase: "call",
        name: clean(event.name),
        ...(event.input === undefined ? {} : { content: clean(event.input) }),
        ...(event.toolCallId === undefined ? {} : { toolCallId: clean(event.toolCallId) }),
      };
    case "tool_result":
      return {
        schemaVersion: 1,
        type: "tool",
        phase: "result",
        ...(event.name === undefined ? {} : { name: clean(event.name) }),
        ...(event.output === undefined ? {} : { content: clean(event.output) }),
        ...(event.toolCallId === undefined ? {} : { toolCallId: clean(event.toolCallId) }),
      };
  }
}

/** Only lifecycle status crosses from rich activity; raw and arbitrary text never do. */
export function progressFromActivity(event: ElwoodActivityEvent): CliProgressRecord | undefined {
  if (event.kind !== "status" || event.status === undefined) return undefined;
  return { schemaVersion: 1, type: "status", status: event.status };
}

/** Warning projection admits only the stable code and bounded public message. */
export function progressFromWarning(
  event: ElwoodWarningEvent,
  clean: CliTextSanitizer,
): Extract<CliProgressRecord, { readonly type: "warning" }> {
  return {
    schemaVersion: 1,
    type: "warning",
    code: clean(event.code),
    message: clean(event.message),
  };
}
