/**
 * Branch-level unit coverage for core activity, error, queue, and trust helpers.
 * Covers PRD §5.4, §9.1, and §10.
 */

import { describe, expect, test } from "vitest";
import {
  activityFromCodexHook,
  activityFromCodexTranscript,
  activityFromHookResult,
} from "../../src/core/activity.ts";
import { ControlQueue } from "../../src/core/control-queue.ts";
import { ElwoodError } from "../../src/core/errors.ts";
import { TrustPromptResponder } from "../../src/core/trust-responder.ts";

describe("core activity branches", () => {
  test("C-API-12 falls back to the event name when tool metadata is missing", () => {
    // Codex tool/assistant activity is transcript-sourced (C-CODEX-16), so its
    // tool hooks stay plain `hook` (labelled by the hook event name) and never
    // re-project a tool_call/tool_result that the transcript already emits.
    // Valid events only — agent/event correlation (M2) rejects impossible shapes
    // at compile time, no `as never` needed.
    const permission = activityFromCodexHook("elwood-7", {
      hook_event_name: "PermissionRequest",
      session_id: "codex-session",
      cwd: "/repo",
      model: "gpt-5.3-codex",
      turn_id: "t1",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    const post = activityFromCodexHook("elwood-7", {
      hook_event_name: "PostToolUse",
      session_id: "codex-session",
      cwd: "/repo",
      model: "gpt-5.3-codex",
      turn_id: "t1",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    expect(permission).toMatchObject({ kind: "hook", label: "PermissionRequest" });
    expect(post).toMatchObject({ kind: "hook", label: "PostToolUse" });
  });

  test("C-API-12 maps non-object transcript items and unnamed tool calls", () => {
    const opaque = activityFromCodexTranscript({
      elwoodSessionId: "elwood-7",
      path: "/tmp/transcript.jsonl",
      item: "not-an-object",
      summary: { kind: "other", label: "unknown" },
    });
    const unnamed = activityFromCodexTranscript({
      elwoodSessionId: "elwood-7",
      path: "/tmp/transcript.jsonl",
      item: { payload: { type: "custom_tool_call", call_id: "call-9" } },
      summary: { kind: "tool_call", label: "custom" },
    });
    expect(opaque).toMatchObject({ kind: "other", label: "unknown" });
    expect(opaque.toolName).toBeUndefined();
    expect(unnamed).toMatchObject({ toolName: "custom", toolUseId: "call-9" });
  });

  test("C-API-17 labels null hook results as generic responses", () => {
    expect(activityFromHookResult("claude", "elwood-7", "Stop", null, false).label).toBe(
      "response",
    );
  });

  test("C-ERR-01 ElwoodError defaults to empty details", () => {
    const error = new ElwoodError("state_corrupt", "state is corrupt");
    expect(error.details).toEqual({});
    expect(error.code).toBe("state_corrupt");
  });

  test("C-API-19 wraps non-Error submit failures in Error instances", async () => {
    const queue = new ControlQueue(
      () => throwPrimitive("primitive submit failure"),
      () => new Error("closed"),
      () => undefined,
    );
    queue.markReady();
    const failure = queue.send("boom", "message");
    await expect(failure).rejects.toBeInstanceOf(Error);
    await expect(failure).rejects.toThrow("primitive submit failure");
  });

  test("C-CLAUDE-14 flags a recognized prompt with no rendered affirmative option as option_pending", () => {
    const writes: string[] = [];
    const responder = new TrustPromptResponder("claude", true);
    const result = responder.handle("Do you trust this folder?\n1. No, exit", (input) =>
      writes.push(input),
    );
    expect(result).toEqual({ kind: "option_pending", prompt: "workspace_trust" });
    expect(writes).toEqual([]);
  });
});

function throwPrimitive(value: string): never {
  // Throws a bare string to exercise non-Error failure normalization.
  throw value;
}
