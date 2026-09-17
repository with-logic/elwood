/**
 * Conformance tests for object-form tool hook handler routing.
 * Covers PRD §6.4, C-HOOK-09, and C-HOOK-10.
 */

import { afterEach, describe, expect, test } from "vitest";
import { registerInitialHooks } from "../../src/claude/session/runtime.ts";
import type { ClaudeEventMap } from "../../src/core/types.ts";
import { TypedEmitter } from "../../src/events/emitter.ts";
import { startClaude } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

describe("ClaudeSessionApi object-form tool hook routing", () => {
  test("C-HOOK-10 routes unknown tool names to the unknown handler", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({
      cwd,
      hooks: { PreToolUse: { unknown: () => ({ permissionDecision: "ask" }) } },
    });
    const result = await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "PreToolUse",
      session_id: "claude-1",
      cwd,
      tool_name: "mcp__linear__create_issue",
      tool_input: { title: "bug" },
    });
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("ask");
  });

  test("C-HOOK-09 tool maps without a matching handler return no decision", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({
      cwd,
      hooks: { PreToolUse: { Bash: () => ({ permissionDecision: "deny" }) } },
    });
    const result = await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "PreToolUse",
      session_id: "claude-1",
      cwd,
      tool_name: "Read",
      tool_input: { file_path: "notes.md" },
    });
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  test("C-HOOK-10 object-form handlers tolerate events without a tool name", async () => {
    const emitter = new TypedEmitter<ClaudeEventMap>();
    registerInitialHooks(emitter, {
      PreToolUse: { unknown: () => ({ permissionDecision: "deny" }) },
    });
    const result = await emitter.request("hook:PreToolUse", {
      hook_event_name: "PreToolUse",
    } as never);
    expect(result).toEqual({ permissionDecision: "deny" });
  });
});
