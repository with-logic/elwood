/**
 * Unit tests for serialized tool input/output on unified activity events.
 * Covers PRD §5.4 C-API-30.
 */

import { describe, expect, test } from "vitest";
import { activityFromCodexTranscript, activityFromHook } from "../../src/core/activity.ts";

describe("Elwood activity tool input/output", () => {
  test("C-API-30 surfaces serialized tool input and output across adapters", () => {
    const call = activityFromHook("claude", "elwood-7", {
      hook_event_name: "PreToolUse",
      session_id: "claude-session",
      cwd: "/repo",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    const bareCall = activityFromHook("claude", "elwood-7", {
      hook_event_name: "PreToolUse",
      session_id: "claude-session",
      cwd: "/repo",
      tool_name: "TodoWrite",
      tool_input: {},
    });
    const claudeResult = activityFromHook("claude", "elwood-7", {
      hook_event_name: "PostToolUse",
      session_id: "claude-session",
      cwd: "/repo",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_response: { stdout: "file.txt" },
    });
    const codexObjectResult = activityFromCodexTranscript({
      elwoodSessionId: "elwood-7",
      path: "/tmp/transcript.jsonl",
      item: { payload: { type: "function_call_output", call_id: "c1", output: { ok: true } } },
      summary: { kind: "tool_result", label: "c1" },
    });
    // Absent source leaves the field absent (no tool_input key at all).
    const noInput = activityFromHook("claude", "elwood-7", {
      hook_event_name: "PreToolUse",
      session_id: "claude-session",
      cwd: "/repo",
      tool_name: "Bash",
    } as never);
    expect(call.toolInput).toBe('{"command":"ls"}');
    expect(bareCall.toolInput).toBe("{}");
    expect(claudeResult.toolOutput).toBe('{"stdout":"file.txt"}');
    expect(codexObjectResult.toolOutput).toBe('{"ok":true}');
    expect(noInput.toolInput).toBeUndefined();
  });

  test("C-API-30 falls back to String for non-serializable tool input", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    const event = activityFromHook("claude", "elwood-8", {
      hook_event_name: "PreToolUse",
      session_id: "claude-session",
      cwd: "/repo",
      tool_name: "Bash",
      tool_input: circular,
    } as never);
    expect(event.toolInput).toBe("[object Object]");
  });
});
