/** Tests concrete fields at both hook boundaries, implementing C-HOOK-07/C-HRESP-01. */

import { expect, test } from "vitest";
import { isClaudeHookInput } from "../../src/claude/validate/input.ts";
import { isClaudeToolInputUpdate } from "../../src/claude/validate/tool-update.ts";
import { concreteInputs, requiredInputs } from "./claude-concrete-tool-fixtures.ts";
import { tool } from "./claude-validate-input-helpers.ts";

test.each(
  Object.entries(concreteInputs),
)("C-HOOK-07 C-HRESP-01 validates every %s field", (name, input) => {
  expect(isClaudeHookInput(tool(name, input))).toBe(true);
  expect(isClaudeToolInputUpdate(name, input)).toBe(true);
  expect(isClaudeToolInputUpdate(name, {})).toBe(true);
  for (const key of Object.keys(input)) {
    const malformed = { ...input, [key]: null };
    expect(isClaudeHookInput(tool(name, malformed)), `${name}.${key} ingress`).toBe(false);
    expect(isClaudeToolInputUpdate(name, malformed), `${name}.${key} rewrite`).toBe(false);
    const omitted: Record<string, unknown> = { ...input };
    delete omitted[key];
    expect(isClaudeHookInput(tool(name, omitted)), `${name}.${key} missing`).toBe(
      !requiredInputs[name as keyof typeof concreteInputs].includes(key),
    );
  }
  expect(isClaudeHookInput(tool(name, { ...input, future_field: true }))).toBe(true);
  expect(isClaudeToolInputUpdate(name, { future_field: true })).toBe(false);
});

test.each([
  "LS",
  "mcp__example__tool",
  "unknown:future",
  "constructor",
  "__proto__",
])("C-HOOK-07 leaves generic %s inputs extensible", (name) => {
  expect(isClaudeHookInput(tool(name, { arbitrary: 42 }))).toBe(true);
  expect(isClaudeToolInputUpdate(name, { arbitrary: 42 })).toBe(true);
});

test("C-HOOK-07 validates nested question options before invoking handlers", () => {
  for (const questions of [
    [{ question: "Q", header: "H", options: [null] }],
    [{ question: "Q", header: "H", options: [{ label: 42 }] }],
    [{ question: "Q", header: "H", options: [{ label: "A", description: 42 }] }],
    [{ question: "Q", header: "H", options: [{ label: "A" }], multiSelect: "yes" }],
  ])
    expect(isClaudeHookInput(tool("AskUserQuestion", { questions }))).toBe(false);
});

test("C-HOOK-07 C-HRESP-01 validates native plan permission objects", () => {
  for (const allowedPrompts of [
    ["build"],
    [null],
    [{ tool: "Read", prompt: "build" }],
    [{ tool: "Bash", prompt: 42 }],
  ]) {
    expect(isClaudeHookInput(tool("ExitPlanMode", { allowedPrompts }))).toBe(false);
    expect(isClaudeToolInputUpdate("ExitPlanMode", { allowedPrompts })).toBe(false);
  }
});
