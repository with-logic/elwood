/**
 * Unit coverage for the activity→simplified-event mapping (PRD §5.8, C-API-48):
 * the four content kinds map to their facade shape (omitting absent tool fields),
 * and every non-content kind maps to `undefined` (not yielded by `stream`).
 */

import { describe, expect, test } from "vitest";
import type { ElwoodActivityEvent, ElwoodActivityKind } from "../../src/core/activity.ts";
import { toTurnEvent, turnEventBytes } from "../../src/core/simple/events.ts";

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

describe("toTurnEvent (C-API-48)", () => {
  test("maps the four content kinds", () => {
    expect(toTurnEvent(activity({ kind: "assistant_message", text: "hi" }))).toEqual({
      type: "text",
      text: "hi",
    });
    expect(toTurnEvent(activity({ kind: "reasoning", text: "hmm" }))).toEqual({
      type: "thinking",
      text: "hmm",
    });
    expect(toTurnEvent(activity({ kind: "tool_call", toolName: "Bash", toolInput: "ls" }))).toEqual(
      { type: "tool_call", name: "Bash", input: "ls" },
    );
  });

  test("omits absent tool fields; falls back to label for a nameless tool_call", () => {
    // tool_call with no toolName uses `label`; no toolInput omits `input`.
    expect(toTurnEvent(activity({ kind: "tool_call", label: "Edit" }))).toEqual({
      type: "tool_call",
      name: "Edit",
    });
    // tool_result with neither name nor output yields the bare shape (both branches false).
    expect(toTurnEvent(activity({ kind: "tool_result" }))).toEqual({ type: "tool_result" });
  });

  test("text/thinking with no text default to the empty string", () => {
    expect(toTurnEvent(activity({ kind: "assistant_message" }))).toEqual({
      type: "text",
      text: "",
    });
    expect(toTurnEvent(activity({ kind: "reasoning" }))).toEqual({
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
      expect(toTurnEvent(activity({ kind }))).toBeUndefined();
    }
  });
});

describe("turnEventBytes (C-API-53 pending-byte accounting)", () => {
  test("measures each event type's payload, treating absent optional fields as zero", () => {
    expect(turnEventBytes({ type: "text", text: "hello" })).toBe(5);
    expect(turnEventBytes({ type: "thinking", text: "hmm" })).toBe(3);
    // tool_call: name + input; input optional.
    expect(turnEventBytes({ type: "tool_call", name: "Bash", input: "ls" })).toBe(6);
    expect(turnEventBytes({ type: "tool_call", name: "Bash" })).toBe(4);
    // tool_result: name + output, both optional (bare shape → 0).
    expect(turnEventBytes({ type: "tool_result", name: "Bash", output: "ok" })).toBe(6);
    expect(turnEventBytes({ type: "tool_result" })).toBe(0);
  });

  test("counts UTF-8 BYTES, not UTF-16 code units — multibyte text exceeds its .length", () => {
    // "界" is one code unit (.length === 1) but three UTF-8 bytes: the cap must measure bytes so
    // multibyte agent text cannot exceed the documented ceiling by counting code units.
    expect("界".length).toBe(1);
    expect(turnEventBytes({ type: "text", text: "界" })).toBe(3);
    expect(turnEventBytes({ type: "tool_result", name: "界", output: "界界" })).toBe(9);
  });
});
