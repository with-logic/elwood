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

const claudeToolActivity = (kind: "tool_call" | "tool_result", extra: Record<string, string>) =>
  activityFromClaudeTranscript({
    elwoodSessionId: "elwood-7",
    path: "/tmp/t.jsonl",
    item: {},
    summary: { kind, label: "Bash", ...extra },
  });

describe("Elwood activity tool input/output", () => {
  test("C-API-30 surfaces serialized tool input and output across adapters", () => {
    const call = claudeToolActivity("tool_call", { toolInput: '{"command":"ls"}' });
    const bareCall = claudeToolActivity("tool_call", { toolInput: "{}" });
    const claudeResult = claudeToolActivity("tool_result", { toolOutput: '{"stdout":"file.txt"}' });
    const codexObjectResult = activityFromCodexTranscript({
      elwoodSessionId: "elwood-7",
      path: "/tmp/transcript.jsonl",
      item: { payload: { type: "function_call_output", call_id: "c1", output: { ok: true } } },
      summary: { kind: "tool_result", label: "c1" },
    });
    // Absent source leaves the field absent (no tool_input key at all).
    const noInput = claudeToolActivity("tool_call", {});
    expect(call.toolInput).toBe('{"command":"ls"}');
    expect(bareCall.toolInput).toBe("{}");
    expect(claudeResult.toolOutput).toBe('{"stdout":"file.txt"}');
    expect(codexObjectResult.toolOutput).toBe('{"ok":true}');
    expect(noInput.toolInput).toBeUndefined();
  });

  test("C-API-30 falls back to String for non-serializable Codex tool input", async () => {
    const { activityFromHook } = await import("../../src/core/activity.ts");
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    const event = activityFromHook("codex", "e2", {
      hook_event_name: "PreToolUse",
      session_id: "s",
      cwd: "/repo",
      tool_name: "Bash",
      tool_input: circular,
    } as never);
    expect(event.toolInput).toBe("[object Object]");
  });

  test("C-CLAUDE-15 Claude tool hook events are NOT emitted as tool activity", async () => {
    const { activityFromHook } = await import("../../src/core/activity.ts");
    // PreToolUse/PostToolUse for Claude are plain hook observations now; the
    // committed tool_call/tool_result comes from the transcript instead.
    const pre = activityFromHook("claude", "e1", {
      hook_event_name: "PreToolUse",
      session_id: "s",
      cwd: "/repo",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    const post = activityFromHook("claude", "e1", {
      hook_event_name: "PostToolUse",
      session_id: "s",
      cwd: "/repo",
      tool_name: "Bash",
      tool_response: { stdout: "x" },
    } as never);
    expect(pre.kind).toBe("hook");
    expect(post.kind).toBe("hook");
    expect(pre.toolInput).toBeUndefined();
    expect(post.toolOutput).toBeUndefined();
  });
});
