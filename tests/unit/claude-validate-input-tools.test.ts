/**
 * Tool-schema and common-field Claude hook input validation coverage.
 * Covers PRD §6.4, C-HOOK-07, and C-HOOK-17.
 */

import { describe, expect, test } from "vitest";
import { isClaudeHookInput as isClaudeHookEvent } from "../../src/claude/validate-input.ts";
import { base, denied, response, tool } from "./claude-validate-input-helpers.ts";

describe("Claude hook input validation (tools)", () => {
  test("C-HOOK-07 C-HOOK-17 validates tool hook inputs by known tool schema", () => {
    expect(isClaudeHookEvent(tool("Agent", { prompt: "do it" }))).toBe(true);
    expect(isClaudeHookEvent(tool("AskUserQuestion", { questions: [] }))).toBe(true);
    expect(
      isClaudeHookEvent(
        tool("AskUserQuestion", {
          questions: [{ question: "Q?", header: "Choice", options: [{ label: "A" }] }],
        }),
      ),
    ).toBe(true);
    expect(isClaudeHookEvent(tool("AskUserQuestion", { questions: [{ question: "Q?" }] }))).toBe(
      false,
    );
    expect(
      isClaudeHookEvent(
        tool("AskUserQuestion", {
          questions: [
            { question: "Q?", header: "Choice", options: [{ label: "A", description: "first" }] },
          ],
        }),
      ),
    ).toBe(true);
    expect(isClaudeHookEvent(base("PreToolUse", { tool_name: "Bash", tool_input: "psql" }))).toBe(
      false,
    );
    expect(isClaudeHookEvent(tool("Bash", { command: "echo ok" }))).toBe(true);
    expect(
      isClaudeHookEvent(tool("Edit", { file_path: "a.ts", old_string: "a", new_string: "b" })),
    ).toBe(true);
    expect(isClaudeHookEvent(tool("ExitPlanMode", {}))).toBe(true);
    expect(isClaudeHookEvent(tool("Glob", { pattern: "*.ts" }))).toBe(true);
    expect(isClaudeHookEvent(tool("Grep", { pattern: "foo" }))).toBe(true);
    expect(isClaudeHookEvent(tool("Read", { file_path: "a.ts" }))).toBe(true);
    expect(isClaudeHookEvent(tool("WebFetch", { url: "https://e.test", prompt: "read" }))).toBe(
      true,
    );
    expect(isClaudeHookEvent(tool("WebSearch", { query: "docs" }))).toBe(true);
    expect(isClaudeHookEvent(tool("Write", { file_path: "a.ts", content: "x" }))).toBe(true);
    expect(isClaudeHookEvent(tool("mcp__server__tool", { raw: true }))).toBe(true);
    expect(isClaudeHookEvent(tool("Bash", {}))).toBe(false);
    expect(isClaudeHookEvent(tool("Bash", { command: "echo ok" }, "PostToolUse"))).toBe(false);
    expect(isClaudeHookEvent(tool("Bash", { command: "echo ok" }, "PostToolUse", response()))).toBe(
      true,
    );
    expect(
      isClaudeHookEvent(
        base("PostToolBatch", {
          tool_calls: [{ tool_name: "Bash", tool_input: { command: "echo ok" } }],
        }),
      ),
    ).toBe(false);
    expect(
      isClaudeHookEvent(
        tool("Bash", { command: "echo ok" }, "PostToolUseFailure", { error: "failed" }),
      ),
    ).toBe(true);
    expect(
      isClaudeHookEvent(tool("Bash", { command: "echo ok" }, "PermissionDenied", { reason: "no" })),
    ).toBe(false);
    expect(
      isClaudeHookEvent(tool("Bash", { command: "echo ok" }, "PermissionDenied", denied())),
    ).toBe(true);
  });

  test("C-HOOK-07 C-HOOK-17 validates typed optional common fields", () => {
    // Valid common fields pass on any event.
    expect(
      isClaudeHookEvent(
        base("UserPromptSubmit", {
          prompt: "hi",
          transcript_path: "/tmp/t.jsonl",
          permission_mode: "plan",
          effort: { level: "high" },
        }),
      ),
    ).toBe(true);
    // transcript_path must be a string when present.
    expect(isClaudeHookEvent(base("UserPromptSubmit", { prompt: "hi", transcript_path: 42 }))).toBe(
      false,
    );
    // permission_mode must be within the union.
    expect(isClaudeHookEvent(base("UserPromptSubmit", { prompt: "hi", permission_mode: 42 }))).toBe(
      false,
    );
    expect(
      isClaudeHookEvent(base("UserPromptSubmit", { prompt: "hi", permission_mode: "yolo" })),
    ).toBe(false);
    // effort must be a record with an in-union level.
    expect(isClaudeHookEvent(base("UserPromptSubmit", { prompt: "hi", effort: "high" }))).toBe(
      false,
    );
    expect(
      isClaudeHookEvent(base("UserPromptSubmit", { prompt: "hi", effort: { level: "turbo" } })),
    ).toBe(false);
    expect(
      isClaudeHookEvent(base("UserPromptSubmit", { prompt: "hi", effort: { level: "max" } })),
    ).toBe(true);
  });
});
