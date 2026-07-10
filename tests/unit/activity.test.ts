/**
 * Unit tests for unified activity event mapping.
 * Covers PRD §5.4.
 */

import { describe, expect, test } from "vitest";
import {
  activityFromClaudeHook,
  activityFromCodexHook,
  activityFromCodexTranscript,
  activityFromHookError,
  activityFromStatus,
  activityFromTerminalExit,
} from "../../src/core/activity.ts";
import { TerminalReplayBuffer } from "../../src/core/terminal-replay.ts";

describe("Elwood activity events", () => {
  test("C-API-12 maps hook prompts with Elwood session identity", () => {
    const event = activityFromClaudeHook("elwood-1", {
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
      hookEventName: "UserPromptSubmit",
    });
  });

  test("C-CODEX-16 Codex tool/stop hooks stay plain hook (transcript is the source)", () => {
    // Codex tool and assistant activity is transcript-sourced (C-CODEX-16), so
    // the PreToolUse/PostToolUse/PermissionRequest/Stop hooks MUST NOT
    // re-project tool_call/tool_result/assistant_message — they would double the
    // transcript's copy. They stay plain `hook` turn-boundary signals here.
    const tool = activityFromCodexHook("elwood-2", {
      hook_event_name: "PermissionRequest",
      session_id: "codex-session",
      cwd: "/repo",
      model: "gpt-5.3-codex",
      turn_id: "turn-1",
      tool_use_id: "tool-1",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    });
    const stop = activityFromCodexHook("elwood-2", {
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
    // Plain hook: still carries base metadata (turnId/toolName from the payload)
    // but never a tool_call kind or a serialized toolInput/toolOutput, and never
    // an assistant_message with the (possibly ghost-text) last_assistant_message.
    expect(tool.kind).toBe("hook");
    expect(tool.label).toBe("PermissionRequest");
    expect(tool).toMatchObject({ turnId: "turn-1", toolName: "Bash", toolUseId: "tool-1" });
    expect(tool.toolInput).toBeUndefined();
    expect(stop.kind).toBe("hook");
    expect(stop.label).toBe("Stop");
    expect(stop.text).toBeUndefined();
    expect(error).toMatchObject({
      kind: "hook_error",
      label: "Stop:timeout",
      hookEventName: "Stop",
    });
  });

  test("C-CODEX-16 PostToolUse hook is plain hook; transcript carries tool_result", () => {
    // A Codex PostToolUse hook is a turn-boundary signal (plain `hook`); the
    // tool_result activity comes from the committed transcript, not the hook.
    const toolResult = activityFromCodexHook("elwood-4", {
      hook_event_name: "PostToolUse",
      session_id: "codex-session",
      cwd: "/repo",
      model: "gpt-5.3-codex",
      turn_id: "t1",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    const unknown = activityFromCodexTranscript({
      elwoodSessionId: "elwood-4",
      path: "/tmp/transcript.jsonl",
      item: { payload: { type: "unknown" } },
      summary: { kind: "other", label: "unknown" },
    });
    expect(toolResult).toMatchObject({ kind: "hook", label: "PostToolUse", toolName: "Bash" });
    expect(toolResult.toolOutput).toBeUndefined();
    expect(unknown).toMatchObject({ kind: "other", label: "unknown" });
  });

  test("C-API-12 maps transcript metadata and lifecycle events", () => {
    const transcript = activityFromCodexTranscript({
      elwoodSessionId: "elwood-3",
      path: "/tmp/transcript.jsonl",
      item: { turn_id: "turn-2", payload: { type: "web_search_call", query: "Elwood" } },
      summary: { kind: "web_search", label: "search", text: "Elwood" },
    });
    const toolCall = activityFromCodexTranscript({
      elwoodSessionId: "elwood-3",
      path: "/tmp/transcript.jsonl",
      item: { payload: { type: "function_call", name: "shell", arguments: "{}" } },
      summary: { kind: "tool_call", label: "shell" },
    });
    const toolResult = activityFromCodexTranscript({
      elwoodSessionId: "elwood-3",
      path: "/tmp/transcript.jsonl",
      item: { payload: { type: "function_call_output", call_id: "call-1", output: "ok" } },
      summary: { kind: "tool_result", label: "call-1" },
    });
    expect(transcript).toMatchObject({
      agent: "codex",
      source: "transcript",
      kind: "web_search",
      label: "search",
      text: "Elwood",
      turnId: "turn-2",
      transcriptPath: "/tmp/transcript.jsonl",
    });
    expect(toolCall).toMatchObject({ toolName: "shell", toolInput: "{}" });
    expect(toolCall.toolOutput).toBeUndefined();
    expect(
      activityFromCodexTranscript({
        elwoodSessionId: "elwood-3",
        path: "/tmp/transcript.jsonl",
        item: { payload: { type: "function_call", name: "shell", call_id: "call-1" } },
        summary: { kind: "tool_call", label: "shell" },
      }),
    ).toMatchObject({ toolUseId: "call-1" });
    expect(toolResult).toMatchObject({ toolUseId: "call-1", toolOutput: "ok" });
    expect(toolResult.toolInput).toBeUndefined();
    expect(activityFromStatus("claude", "elwood-3", "ready")).toMatchObject({
      label: "ready",
      status: "ready",
    });
    expect(activityFromTerminalExit("claude", "elwood-3", 0)).toMatchObject({
      kind: "terminal_exit",
      exitCode: 0,
    });
  });

  test("C-API-17 terminal replay trims oldest chunks over the byte limit", () => {
    const buffer = new TerminalReplayBuffer("elwood-6", 4);
    const replayed: string[] = [];
    buffer.push("ab");
    buffer.push("cd");
    buffer.push("ef");
    buffer.replay((event) => replayed.push(event.data));
    expect(replayed).toEqual(["cdef"]);
  });
});
