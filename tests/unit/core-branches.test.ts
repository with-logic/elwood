/**
 * Branch-level unit coverage for core activity, error, queue, and trust helpers.
 * Covers PRD §5.4, §9.1, and §10.
 */

import { describe, expect, test } from "vitest";
import type { ClaudeHookEventFor } from "../../src/claude/hooks.ts";
import {
  activityFromCodexTranscript,
  activityFromHook,
  activityFromHookResult,
} from "../../src/core/activity.ts";
import { ControlQueue } from "../../src/core/control-queue.ts";
import { ElwoodError } from "../../src/core/errors.ts";
import { WorkspaceTrustResponder } from "../../src/core/workspace-trust.ts";

describe("core activity branches", () => {
  test("C-API-12 falls back to hook event names when tool metadata is missing", () => {
    const permission = activityFromHook("claude", "elwood-7", {
      hook_event_name: "PermissionRequest",
      session_id: "claude-session",
      cwd: "/repo",
    } as ClaudeHookEventFor<"PermissionRequest">);
    const batch = activityFromHook("claude", "elwood-7", {
      hook_event_name: "PostToolBatch",
      session_id: "claude-session",
      cwd: "/repo",
      tool_calls: [],
    });
    expect(permission).toMatchObject({ kind: "tool_call", label: "PermissionRequest" });
    expect(batch).toMatchObject({ kind: "tool_result", label: "PostToolBatch" });
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

  test("C-CLAUDE-10 leaves trust prompts alone when no trusted option is listed", () => {
    const writes: string[] = [];
    const responder = new WorkspaceTrustResponder("claude", true);
    const result = responder.handle("Do you trust this folder?\n1. No, exit", (input) =>
      writes.push(input),
    );
    expect(result).toBeUndefined();
    expect(writes).toEqual([]);
  });
});

function throwPrimitive(value: string): never {
  // Throws a bare string to exercise non-Error failure normalization.
  throw value;
}
