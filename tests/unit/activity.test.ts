/**
 * Unit tests for unified activity event mapping.
 * Covers PRD §5.4.
 */

import { describe, expect, test } from "vitest";
import {
  activityFromCodexTranscript,
  activityFromHook,
  activityFromHookError,
  activityFromHookResult,
  activityFromStatus,
  activityFromTerminalExit,
} from "../../src/core/activity.ts";
import { TerminalReplayBuffer } from "../../src/core/terminal-replay.ts";

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
      hookEventName: "UserPromptSubmit",
    });
  });

  test("C-API-12 maps tools, assistant messages, and hook errors", () => {
    const tool = activityFromHook("codex", "elwood-2", {
      hook_event_name: "PermissionRequest",
      session_id: "codex-session",
      cwd: "/repo",
      model: "gpt-5.3-codex",
      turn_id: "turn-1",
      tool_use_id: "tool-1",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
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
    expect(tool).toMatchObject({ turnId: "turn-1", toolName: "Bash", toolUseId: "tool-1" });
    expect(tool.toolInput).toBe('{"command":"npm test"}');
    expect(tool.toolOutput).toBeUndefined();
    expect(stop.kind).toBe("assistant_message");
    expect(stop.text).toBe("Done.");
    expect(error).toMatchObject({
      kind: "hook_error",
      label: "Stop:timeout",
      hookEventName: "Stop",
    });
  });

  test("C-API-12 maps tool results and unknown transcript items", () => {
    // Codex still maps tool hooks to tool activity; Claude tool activity is
    // transcript-sourced (C-CLAUDE-15) and covered in activity-tool-io.test.ts.
    const toolResult = activityFromHook("codex", "elwood-4", {
      hook_event_name: "PostToolUse",
      session_id: "codex-session",
      cwd: "/repo",
      tool_name: "Read",
      tool_input: { file_path: "README.md" },
      tool_response: { content: "ok" },
    } as never);
    const unknown = activityFromCodexTranscript({
      elwoodSessionId: "elwood-4",
      path: "/tmp/transcript.jsonl",
      item: { payload: { type: "unknown" } },
      summary: { kind: "other", label: "unknown" },
    });
    expect(toolResult).toMatchObject({ kind: "tool_result", label: "Read" });
    expect(toolResult.toolOutput).toBe('{"content":"ok"}');
    expect(toolResult.toolInput).toBeUndefined();
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

  test("C-API-12 maps hook result labels for known response variants", () => {
    expect(
      activityFromHookResult(
        "claude",
        "elwood-5",
        "SessionStart",
        {
          additionalContext: "ctx",
        },
        false,
      ).label,
    ).toBe("context");
    expect(
      activityFromHookResult("claude", "elwood-5", "Elicitation", { action: "accept" }, false)
        .label,
    ).toBe("accept");
    expect(
      activityFromHookResult("claude", "elwood-5", "PermissionDenied", { retry: true }, false)
        .label,
    ).toBe("retry");
    expect(
      activityFromHookResult(
        "claude",
        "elwood-5",
        "WorktreeCreate",
        {
          worktreePath: "/tmp/work",
        },
        false,
      ).label,
    ).toBe("worktree");
    expect(activityFromHookResult("codex", "elwood-5", "Stop", undefined, true)).toMatchObject({
      hookEventName: "Stop",
      failedOpen: true,
    });
    expect(
      activityFromHookResult("codex", "elwood-5", "Stop", { ignored: true }, false).label,
    ).toBe("response");
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
