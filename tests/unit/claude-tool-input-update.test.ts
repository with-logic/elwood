/**
 * Validation of Claude tool-specific `updatedInput` rewrites in hook responses
 * (PRD §6.4, C-HRESP-01): known tools accept only their own fields, MCP tools and
 * tool-less hooks accept any record.
 */

import { describe, expect, test } from "vitest";
import { isClaudeToolInputUpdate } from "../../src/claude/validate/tool-update.ts";

describe("isClaudeToolInputUpdate", () => {
  test("C-HRESP-01 validates tool-specific input rewrites", () => {
    expect(isClaudeToolInputUpdate("Bash", { command: "echo ok" })).toBe(true);
    expect(isClaudeToolInputUpdate("Edit", { old_string: "a" })).toBe(true);
    expect(isClaudeToolInputUpdate("Grep", { pattern: "x" })).toBe(true);
    expect(isClaudeToolInputUpdate("Bash", { questions: [] })).toBe(false);
    expect(isClaudeToolInputUpdate("mcp__server__tool", { questions: [] })).toBe(true);
    // A hook with no tool name has no table and accepts any record.
    expect(isClaudeToolInputUpdate(undefined, { anything: 1 })).toBe(true);
  });
});
