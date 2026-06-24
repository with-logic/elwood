/**
 * Focused unit coverage for Claude hook result runtime validation.
 * Covers PRD §6.4 and C-HOOK-06.
 */

import { describe, expect, test } from "vitest";
import { isClaudeHookResult } from "../../src/claude/validate-result.ts";

describe("Claude hook result validation", () => {
  test("C-HOOK-06 validates hook results by event semantics", () => {
    expect(isClaudeHookResult("PreToolUse", null)).toBe(false);
    expect(isClaudeHookResult("PreToolUse", { permissionDecision: "allow" })).toBe(true);
    expect(isClaudeHookResult("PreToolUse", { additionalContext: "ctx" })).toBe(true);
    expect(
      isClaudeHookResult(
        {
          hook_event_name: "PreToolUse",
          session_id: "s1",
          cwd: "/tmp",
          tool_name: "Bash",
          tool_input: { command: "echo ok" },
        },
        { permissionDecision: "allow", updatedInput: { questions: [] } },
      ),
    ).toBe(false);
    expect(
      isClaudeHookResult("PreToolUse", { permissionDecision: "allow", updatedInput: 42 }),
    ).toBe(false);
    expect(isClaudeHookResult("PreToolUse", { permissionDecision: "allow", extra: true })).toBe(
      false,
    );
    expect(isClaudeHookResult("Stop", { permissionDecision: "allow" })).toBe(false);
    expect(isClaudeHookResult("PermissionRequest", { behavior: "deny" })).toBe(true);
    expect(isClaudeHookResult("PermissionRequest", { behavior: "deny", updatedInput: 42 })).toBe(
      false,
    );
    expect(isClaudeHookResult("PermissionRequest", { behavior: "deny", extra: true })).toBe(false);
    expect(isClaudeHookResult("Stop", { behavior: "deny" })).toBe(false);
    expect(isClaudeHookResult("PermissionDenied", { retry: true })).toBe(true);
    expect(isClaudeHookResult("PermissionDenied", { retry: false })).toBe(false);
    expect(isClaudeHookResult("WorktreeCreate", { worktreePath: "/tmp/w" })).toBe(true);
    expect(isClaudeHookResult("WorktreeRemove", { worktreePath: "/tmp/w" })).toBe(false);
    expect(isClaudeHookResult("Stop", { worktreePath: "/tmp/w" })).toBe(false);
    expect(isClaudeHookResult("Elicitation", { action: "accept" })).toBe(true);
    expect(isClaudeHookResult("Stop", { action: "accept" })).toBe(false);
    expect(isClaudeHookResult("SubagentStop", { decision: "block", reason: "wait" })).toBe(true);
    expect(isClaudeHookResult("Stop", { decision: "block" })).toBe(false);
    expect(isClaudeHookResult("Notification", { additionalContext: "nope" })).toBe(false);
    expect(isClaudeHookResult("SessionStart", { additionalContext: "ctx" })).toBe(true);
    expect(isClaudeHookResult("SessionStart", {})).toBe(true);
    expect(isClaudeHookResult("SessionStart", { other: true })).toBe(false);
    expect(isClaudeHookResult("SessionStart", { watchPaths: [".env"] })).toBe(true);
    expect(isClaudeHookResult("SessionStart", { watchPaths: [1] })).toBe(false);
    expect(isClaudeHookResult("SessionEnd", { additionalContext: "too late" })).toBe(false);
    expect(isClaudeHookResult("TaskCreated", { continue: false })).toBe(true);
    expect(isClaudeHookResult("TaskCreated", { continue: false, stopReason: "wait" })).toBe(true);
    expect(isClaudeHookResult("TaskCreated", { continue: true })).toBe(false);
    expect(isClaudeHookResult("PostToolUse", { additionalContext: "recorded" })).toBe(true);
    expect(isClaudeHookResult("PostToolUse", { updatedToolOutput: "ok" })).toBe(true);
    expect(isClaudeHookResult("PostToolUse", { extra: "bad" })).toBe(false);
  });
});
