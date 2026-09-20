/** Optional fields remain strict except drift-tolerant StopFailure diagnostics (C-HOOK-07/20). */

import { expect, test } from "vitest";
import { isClaudeHookInput } from "../../src/claude/validate/input.ts";
import { cronFields, eventFieldCases, taskFields } from "./claude-event-field-fixtures.ts";
import { base, batchToolCall } from "./claude-validate-input-helpers.ts";

test.each(
  eventFieldCases,
)("C-HOOK-07/20 validates %s optional fields with the StopFailure exception", (name, required, optional) => {
  expect(isClaudeHookInput(base(name, { ...required, ...optional }))).toBe(true);
  expect(isClaudeHookInput(base(name, required))).toBe(true);
  for (const key of Object.keys(optional)) {
    expect(isClaudeHookInput(base(name, { ...required, ...optional, [key]: null })), key).toBe(
      name === "StopFailure",
    );
  }
});

test.each([
  ["background_tasks", taskFields],
  ["session_crons", cronFields],
] as const)("C-HOOK-07 validates nested %s fields", (field, entry) => {
  expect(isClaudeHookInput(base("Stop", { [field]: [] }))).toBe(true);
  expect(isClaudeHookInput(base("Stop", { [field]: [null] }))).toBe(false);
  expect(isClaudeHookInput(base("Stop", { [field]: [{}] }))).toBe(false);
  for (const key of Object.keys(entry)) {
    expect(isClaudeHookInput(base("Stop", { [field]: [{ ...entry, [key]: null }] })), key).toBe(
      false,
    );
  }
});

test("C-HOOK-07 validates optional nested batch tool IDs", () => {
  const valid = { ...batchToolCall(), tool_use_id: "tool" };
  expect(isClaudeHookInput(base("PostToolBatch", { tool_calls: [valid] }))).toBe(true);
  expect(
    isClaudeHookInput(base("PostToolBatch", { tool_calls: [{ ...valid, tool_use_id: 42 }] })),
  ).toBe(false);
});
