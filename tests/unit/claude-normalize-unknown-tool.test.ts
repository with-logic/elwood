/**
 * Claude hook normalization of tool names Elwood does not know (PRD §6.4, C-HOOK-08):
 * a future tool is surfaced as `unknown:<name>` rather than dropped.
 */

import { describe, expect, test } from "vitest";
import { normalizeClaudeHookEvent } from "../../src/claude/normalize.ts";

describe("normalizeClaudeHookEvent", () => {
  test("C-HOOK-08 normalizes future Claude tool names", () => {
    const normalized = normalizeClaudeHookEvent({
      hook_event_name: "PreToolUse",
      session_id: "s1",
      cwd: "/tmp",
      tool_name: "FutureTool",
      tool_input: { raw: true },
    });
    expect("tool_name" in normalized && normalized.tool_name).toBe("unknown:FutureTool");
  });
});
