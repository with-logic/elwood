/** Regression tests for complete hook input and response contracts (PRD §6.4, §7A.2). */

import { expect, test } from "vitest";
import { isClaudeHookInput } from "../../src/claude/validate/input.ts";
import { isClaudeHookResult } from "../../src/claude/validate/result.ts";
import { isCodexHookResult } from "../../src/codex/hooks/validate-result.ts";
import { base, tool } from "./claude-validate-input-helpers.ts";

test.each([
  ["PowerShell", {}],
  ["TaskGet", {}],
  ["Bash", { command: "echo ok", description: 42 }],
  ["WebSearch", { query: "test", allowed_domains: 42 }],
])("C-HOOK-07 rejects malformed concrete %s input", (name, input) => {
  expect(isClaudeHookInput(tool(name as string, input))).toBe(false);
});

test("C-HOOK-07 validates Stop's typed optional fields", () => {
  expect(isClaudeHookInput(base("Stop", { background_tasks: 42 }))).toBe(false);
});

test("C-HRESP-01 validates ID tool rewrites before serialization", () => {
  expect(
    isClaudeHookResult(tool("TaskGet", { taskId: "1" }, "PermissionRequest") as never, {
      behavior: "allow",
      updatedInput: { taskId: 42 },
    }),
  ).toBe(false);
});

test.each([
  "Bash",
  "apply_patch",
])("C-HRESP-07 preserves nullable descriptions in %s rewrites", (tool_name) => {
  const event = {
    hook_event_name: "PreToolUse",
    tool_name,
    tool_input: { command: "before", description: null },
  } as const;
  expect(
    isCodexHookResult(event as never, {
      permissionDecision: "allow",
      updatedInput: { ...event.tool_input, command: "after" },
    }),
  ).toBe(true);
});
