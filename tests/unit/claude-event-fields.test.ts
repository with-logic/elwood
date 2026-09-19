/** Typed optional event fields cannot carry invalid values through the bridge (C-HOOK-07). */

import { expect, test } from "vitest";
import { isClaudeHookInput } from "../../src/claude/validate/input.ts";
import { cronFields, eventFieldCases, taskFields } from "./claude-event-field-fixtures.ts";
import { base, batchToolCall } from "./claude-validate-input-helpers.ts";

test.each(eventFieldCases)("C-HOOK-07 validates %s optional fields", (name, required, optional) => {
  expect(isClaudeHookInput(base(name, { ...required, ...optional }))).toBe(true);
  expect(isClaudeHookInput(base(name, required))).toBe(true);
  for (const key of Object.keys(optional)) {
    // `StopFailure` is the ONE deliberate exception to strict optional-field typing: it is
    // Claude REJECTING the turn, so a drifted payload must still reach the failure reader rather
    // than becoming a `hookError` and settling as an empty success (C-API-57, #19). Its own
    // admit-and-classify contract is pinned in `turn-failure-ingress.test.ts`; every other event
    // still rejects a malformed optional field here.
    const expected = name === "StopFailure" ? true : false;
    expect(isClaudeHookInput(base(name, { ...required, ...optional, [key]: null })), key).toBe(
      expected,
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
