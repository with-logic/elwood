/**
 * Event-specific Codex hook input and result validation coverage.
 * Covers PRD §7A.2.
 */

import { describe, expect, test } from "vitest";
import {
  isCodexHookEvent,
  isCodexHookResult,
  normalizeCodexHookEvent,
} from "../../src/codex/validate.ts";

describe("Codex hook validation", () => {
  test("C-HOOK-13 validates Codex hook input schemas", () => {
    expect(isCodexHookEvent(null)).toBe(false);
    expect(isCodexHookEvent({ hook_event_name: "Stop" })).toBe(false);
    expect(isCodexHookEvent(base("Unknown", { turn_id: "turn-1" }))).toBe(false);
    expect(isCodexHookEvent(base("Stop"))).toBe(false);
    expect(isCodexHookEvent(base("Stop", { turn_id: "turn-1", stop_hook_active: false }))).toBe(
      true,
    );
    expect(
      isCodexHookEvent(
        base("Stop", {
          turn_id: "turn-1",
          stop_hook_active: false,
          permission_mode: "invalid",
        }),
      ),
    ).toBe(false);
    expect(
      isCodexHookEvent(
        base("PreToolUse", { turn_id: "turn-1", tool_name: "Bash", tool_input: {} }),
      ),
    ).toBe(false);
    expect(
      isCodexHookEvent(
        base("PreToolUse", {
          turn_id: "turn-1",
          tool_name: "mcp__server__tool",
          tool_input: { raw: true },
        }),
      ),
    ).toBe(true);
    expect(isCodexHookEvent(base("SubagentStart", subagent()))).toBe(true);
    const rawTool = base("PreToolUse", {
      turn_id: "turn-1",
      tool_name: "web_search",
      tool_input: { query: "docs" },
    });
    expect(isCodexHookEvent(rawTool)).toBe(true);
    if (!isCodexHookEvent(rawTool)) throw new Error("expected Codex hook event");
    const normalized = normalizeCodexHookEvent(rawTool);
    expect("tool_name" in normalized && normalized.tool_name).toBe("unknown:web_search");
    expect(
      isCodexHookEvent(
        base("SubagentStop", {
          ...subagent(),
          stop_hook_active: false,
          agent_transcript_path: null,
        }),
      ),
    ).toBe(true);
  });

  test("C-HOOK-13 validates Codex hook result semantics", () => {
    expect(isCodexHookResult("PreToolUse", { permissionDecision: "allow" })).toBe(true);
    expect(isCodexHookResult("PreToolUse", { continue: false })).toBe(false);
    expect(
      isCodexHookResult("PreToolUse", {
        permissionDecision: "allow",
        updatedInput: { command: "echo ok" },
      }),
    ).toBe(true);
    const bashEvent = base("PreToolUse", {
      turn_id: "turn-1",
      tool_name: "Bash",
      tool_input: { command: "echo ok" },
    });
    if (!isCodexHookEvent(bashEvent)) throw new Error("expected Codex hook event");
    expect(
      isCodexHookResult(bashEvent, {
        permissionDecision: "allow",
        updatedInput: { query: "docs" },
      }),
    ).toBe(false);
    expect(
      isCodexHookResult("PreToolUse", {
        permissionDecision: "allow",
        updatedInput: 42,
      }),
    ).toBe(false);
    expect(isCodexHookResult("PreToolUse", { additionalContext: "context" })).toBe(true);
    expect(
      isCodexHookResult("PreToolUse", {
        permissionDecision: "bogus",
        additionalContext: "context",
      }),
    ).toBe(false);
    expect(
      isCodexHookResult("PreToolUse", {
        permissionDecision: "allow",
        extra: true,
      }),
    ).toBe(false);
    expect(
      isCodexHookResult("PreToolUse", {
        permissionDecision: "deny",
        permissionDecisionReason: "no",
        updatedInput: {},
      }),
    ).toBe(false);
    expect(isCodexHookResult("PermissionRequest", { continue: false })).toBe(false);
    expect(isCodexHookResult("PermissionRequest", { behavior: "allow", extra: true })).toBe(false);
    expect(isCodexHookResult("PostCompact", { continue: "no" })).toBe(false);
    expect(isCodexHookResult("PostCompact", { continue: false })).toBe(false);
    expect(isCodexHookResult("PostToolUse", { continue: false })).toBe(false);
    expect(isCodexHookResult("UserPromptSubmit", { systemMessage: "seen" })).toBe(false);
    expect(isCodexHookResult("Stop", { continue: false })).toBe(false);
    expect(isCodexHookResult("Stop", { continue: false, stopReason: "wait" })).toBe(true);
    expect(isCodexHookResult("PostCompact", {})).toBe(false);
    expect(isCodexHookResult("PostCompact", { nope: true })).toBe(false);
  });
});

function base(hook_event_name: string, fields: Record<string, unknown> = {}) {
  return {
    hook_event_name,
    session_id: "codex-1",
    cwd: "/tmp/project",
    model: "gpt-5.3-codex",
    ...fields,
  };
}

function subagent() {
  return { turn_id: "turn-1", agent_id: "agent-1", agent_type: "explorer" };
}
