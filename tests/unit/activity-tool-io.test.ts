/**
 * Unit tests for serialized tool input/output on unified activity events.
 * Covers PRD §5.4 C-API-30. Claude tool io comes from the committed transcript
 * (C-CLAUDE-15); Codex tool io comes from its transcript.
 */

import { describe, expect, test } from "vitest";
import type { ClaudeTranscriptSummary } from "../../src/claude/transcript/summary.ts";
import {
  activityFromClaudeTranscript,
  activityFromCodexTranscript,
} from "../../src/core/activity.ts";

const claudeCall = (toolInput?: string) =>
  activityFromClaudeTranscript({
    elwoodSessionId: "elwood-7",
    path: "/tmp/t.jsonl",
    item: {},
    summary: {
      kind: "tool_call",
      label: "Bash",
      toolName: "Bash",
      ...(toolInput ? { toolInput } : {}),
    },
  });
const claudeResult2 = (toolOutput: string) =>
  activityFromClaudeTranscript({
    elwoodSessionId: "elwood-7",
    path: "/tmp/t.jsonl",
    item: {},
    summary: { kind: "tool_result", label: "c", toolUseId: "c", toolOutput },
  });

describe("Elwood activity tool input/output", () => {
  test("C-API-30 surfaces serialized tool input and output across adapters", () => {
    const call = claudeCall('{"command":"ls"}');
    const bareCall = claudeCall("{}");
    const claudeResult = claudeResult2('{"stdout":"file.txt"}');
    const codexObjectResult = activityFromCodexTranscript({
      elwoodSessionId: "elwood-7",
      path: "/tmp/transcript.jsonl",
      item: { payload: { type: "function_call_output", call_id: "c1", output: { ok: true } } },
      summary: { kind: "tool_result", label: "c1" },
    });
    // Absent source leaves the field absent (no tool_input key at all).
    const noInput = claudeCall();
    expect(call.toolInput).toBe('{"command":"ls"}');
    expect(bareCall.toolInput).toBe("{}");
    expect(claudeResult.toolOutput).toBe('{"stdout":"file.txt"}');
    expect(codexObjectResult.toolOutput).toBe('{"ok":true}');
    expect(noInput.toolInput).toBeUndefined();
  });

  test("C-CLAUDE-15 a tool_call keeps its toolUseId and a tool_result omits an absent output", () => {
    // A tool_call MAY carry a correlating toolUseId (present here); a tool_result
    // MUST carry its toolUseId but its toolOutput is optional (absent here).
    const call = activityFromClaudeTranscript({
      elwoodSessionId: "elwood-7",
      path: "/tmp/t.jsonl",
      item: {},
      summary: { kind: "tool_call", label: "Bash", toolName: "Bash", toolUseId: "u1" },
    });
    const result = activityFromClaudeTranscript({
      elwoodSessionId: "elwood-7",
      path: "/tmp/t.jsonl",
      item: {},
      summary: { kind: "tool_result", label: "u1", toolUseId: "u1" },
    });
    expect(call).toMatchObject({ kind: "tool_call", toolName: "Bash", toolUseId: "u1" });
    expect(result).toMatchObject({ kind: "tool_result", toolUseId: "u1" });
    expect(result.toolOutput).toBeUndefined(); // absent output leaves the field absent
  });

  test("C-CLAUDE-15 an assistant_message projection carries its committed text and path", () => {
    const message = activityFromClaudeTranscript({
      elwoodSessionId: "elwood-7",
      path: "/tmp/t.jsonl",
      item: {},
      summary: { kind: "assistant_message", label: "assistant", text: "hello" },
    });
    expect(message).toMatchObject({
      kind: "assistant_message",
      source: "transcript",
      text: "hello",
      transcriptPath: "/tmp/t.jsonl",
    });
    // The tool fields are absent for an assistant message (variant is precise).
    expect(message.toolName).toBeUndefined();
    expect(message.toolUseId).toBeUndefined();
  });

  test("C-CLAUDE-15 the Claude-transcript projection REQUIRES each variant's fields", () => {
    // Finding D: the projection is built by switching on the summary discriminant,
    // so the compiler enforces that an assistant_message carries `text`, a
    // tool_call its `toolName`, and a tool_result its correlating `toolUseId`. A
    // future summary variant that omits a required field fails to typecheck here.
    // @ts-expect-error assistant_message without `text` is rejected at the boundary
    const badMessage: ClaudeTranscriptSummary = { kind: "assistant_message", label: "a" };
    // @ts-expect-error tool_call without `toolName` is rejected at the boundary
    const badCall: ClaudeTranscriptSummary = { kind: "tool_call", label: "Bash" };
    // @ts-expect-error tool_result without `toolUseId` is rejected at the boundary
    const badResult: ClaudeTranscriptSummary = { kind: "tool_result", label: "c" };
    expect([badMessage, badCall, badResult]).toHaveLength(3);
  });

  test("C-CLAUDE-15 Claude tool hook events are NOT emitted as tool activity", async () => {
    const { activityFromClaudeHook } = await import("../../src/core/activity.ts");
    // PreToolUse/PostToolUse for Claude are plain hook observations now; the
    // committed tool_call/tool_result comes from the transcript instead.
    const pre = activityFromClaudeHook("e1", {
      hook_event_name: "PreToolUse",
      session_id: "s",
      cwd: "/repo",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    const post = activityFromClaudeHook("e1", {
      hook_event_name: "PostToolUse",
      session_id: "s",
      cwd: "/repo",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_response: { stdout: "x" },
    });
    expect(pre.kind).toBe("hook");
    expect(post.kind).toBe("hook");
    expect(pre.toolInput).toBeUndefined();
    expect(post.toolOutput).toBeUndefined();
  });
});
