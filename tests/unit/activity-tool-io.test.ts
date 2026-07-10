/**
 * Unit tests for serialized tool input/output on unified activity events.
 * Covers PRD §5.4 C-API-30. Claude tool io comes from the committed transcript
 * (C-CLAUDE-15); Codex tool io comes from its transcript.
 */

import { describe, expect, test } from "vitest";
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
