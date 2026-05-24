/**
 * Unit tests for unified activity event mapping.
 * Covers PRD §5.4.
 */

import { describe, expect, test } from "bun:test";
import {
  activityFromCodexTranscript,
  activityFromHook,
  activityFromHookError,
  activityFromStatus,
  activityFromTerminalExit,
} from "../../src/core/activity.ts";

describe("Elwood activity events", () => {
  test("C-API-12 maps hook prompts with Elwood session identity", () => {
    const event = activityFromHook("claude", "elwood-1", {
      hook_event_name: "UserPromptSubmit",
      session_id: "claude-session",
      cwd: "/repo",
      prompt: "hello",
    });
    expect(event).toMatchObject({
      elwoodSessionId: "elwood-1",
      agent: "claude",
      source: "hook",
      kind: "user_message",
      label: "user",
      text: "hello",
    });
  });

  test("C-API-12 maps tools, assistant messages, and hook errors", () => {
    const tool = activityFromHook("codex", "elwood-2", {
      hook_event_name: "PermissionRequest",
      session_id: "codex-session",
      cwd: "/repo",
      model: "gpt-5.3-codex",
      turn_id: "turn-1",
      tool_name: "Bash",
      tool_input: { command: "bun test" },
    });
    const stop = activityFromHook("codex", "elwood-2", {
      hook_event_name: "Stop",
      session_id: "codex-session",
      cwd: "/repo",
      model: "gpt-5.3-codex",
      turn_id: "turn-1",
      stop_hook_active: false,
      last_assistant_message: "Done.",
    });
    const error = activityFromHookError("codex", {
      elwoodSessionId: "elwood-2",
      hookEventName: "Stop",
      category: "timeout",
      message: "timeout",
      timeoutMs: 1,
    });
    expect(tool.kind).toBe("tool_call");
    expect(tool.label).toBe("Bash");
    expect(stop.kind).toBe("assistant_message");
    expect(stop.text).toBe("Done.");
    expect(error).toMatchObject({ kind: "hook_error", label: "Stop:timeout" });
  });

  test("C-API-12 maps tool results and unknown transcript items", () => {
    const toolResult = activityFromHook("claude", "elwood-4", {
      hook_event_name: "PostToolUse",
      session_id: "claude-session",
      cwd: "/repo",
      tool_name: "Read",
      tool_input: { file_path: "README.md" },
      tool_response: { content: "ok" },
    });
    const unknown = activityFromCodexTranscript({
      elwoodSessionId: "elwood-4",
      path: "/tmp/transcript.jsonl",
      item: { payload: { type: "unknown" } },
      summary: { kind: "other", label: "unknown" },
    });
    expect(toolResult).toMatchObject({ kind: "tool_result", label: "Read" });
    expect(unknown).toMatchObject({ kind: "hook", label: "unknown" });
  });

  test("C-API-12 maps transcript and lifecycle events", () => {
    const transcript = activityFromCodexTranscript({
      elwoodSessionId: "elwood-3",
      path: "/tmp/transcript.jsonl",
      item: { payload: { type: "web_search_call", query: "Elwood" } },
      summary: { kind: "web_search", label: "search", text: "Elwood" },
    });
    expect(transcript).toMatchObject({
      agent: "codex",
      source: "transcript",
      kind: "web_search",
      label: "search",
      text: "Elwood",
    });
    expect(activityFromStatus("claude", "elwood-3", "ready").label).toBe("ready");
    expect(activityFromTerminalExit("claude", "elwood-3", 0).kind).toBe("terminal_exit");
  });
});
