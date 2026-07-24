/**
 * Unit coverage for the activity→simplified-event mapping (PRD §5.8, C-API-48):
 * the four content kinds map to their facade shape (omitting absent tool fields),
 * and every non-content kind maps to `undefined` (not yielded by `stream`).
 */

import { describe, expect, test } from "vitest";
import type { ElwoodActivityEvent, ElwoodActivityKind } from "../../src/core/activity.ts";
import { toSimpleTurnEvent } from "../../src/core/simple/events.ts";

function activity(partial: Partial<ElwoodActivityEvent>): ElwoodActivityEvent {
  return {
    elwoodSessionId: "s1",
    agent: "claude",
    source: "transcript",
    kind: "assistant_message",
    label: "x",
    ...partial,
  };
}

describe("toSimpleTurnEvent (C-API-48)", () => {
  test("maps the four content kinds", () => {
    expect(toSimpleTurnEvent(activity({ kind: "assistant_message", text: "hi" }))).toEqual({
      type: "text",
      text: "hi",
    });
    expect(toSimpleTurnEvent(activity({ kind: "reasoning", text: "hmm" }))).toEqual({
      type: "thinking",
      text: "hmm",
    });
    expect(
      toSimpleTurnEvent(activity({ kind: "tool_call", toolName: "Bash", toolInput: "ls" })),
    ).toEqual({ type: "tool_call", name: "Bash", input: "ls" });
  });

  test("omits absent tool fields; falls back to label for a nameless tool_call", () => {
    // tool_call with no toolName uses `label`; no toolInput omits `input`.
    expect(toSimpleTurnEvent(activity({ kind: "tool_call", label: "Edit" }))).toEqual({
      type: "tool_call",
      name: "Edit",
    });
    // tool_result with neither name nor output yields the bare shape (both branches false).
    expect(toSimpleTurnEvent(activity({ kind: "tool_result" }))).toEqual({ type: "tool_result" });
  });

  test("text/thinking with no text default to the empty string", () => {
    expect(toSimpleTurnEvent(activity({ kind: "assistant_message" }))).toEqual({
      type: "text",
      text: "",
    });
    expect(toSimpleTurnEvent(activity({ kind: "reasoning" }))).toEqual({
      type: "thinking",
      text: "",
    });
  });

  test("every non-content kind maps to undefined (not yielded by stream)", () => {
    const nonContent: ElwoodActivityKind[] = [
      "user_message",
      "web_search",
      "status",
      "terminal_exit",
      "notification",
      "warning",
      "startup_prompt",
      "attention",
      "hook",
      "hook_result",
      "hook_error",
      "other",
    ];
    for (const kind of nonContent) {
      expect(toSimpleTurnEvent(activity({ kind }))).toBeUndefined();
    }
  });
});
