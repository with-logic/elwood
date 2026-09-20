/** Drift-tolerant Claude rejection ingress and diagnostics; PRD §6.1 / C-HOOK-20. */

import { expect, test } from "vitest";
import { summarizeHookEvent } from "../../dev/web/log.ts";
import type { ClaudeHookEventFor } from "../../src/claude/hooks/index.ts";
import { stopFailureDiagnostic } from "../../src/claude/hooks/stop-failure.ts";
import { isClaudeHookInput } from "../../src/claude/validate/input.ts";

const common = { hook_event_name: "StopFailure", session_id: "s1", cwd: "/tmp" } as const;

test.each([
  {},
  { error: null },
  { error: { code: "rate_limit" } },
  { error_details: { text: "nope" } },
  { last_assistant_message: 7 },
  { last_assistant_message: "unrelated" },
])("C-HOOK-20 preserves a StopFailure with drifted fields: %j", (fields) => {
  const event = { ...common, ...fields } satisfies ClaudeHookEventFor<"StopFailure">;
  expect(isClaudeHookInput(event)).toBe(true);
  expect(stopFailureDiagnostic(event)).toEqual({ message: "Claude rejected the turn." });
  expect(summarizeHookEvent(event)).toBe("hook StopFailure: Claude rejected the turn.");
});

test("C-HOOK-20 requires the common envelope and keeps other hooks strict", () => {
  expect(isClaudeHookInput({ hook_event_name: "StopFailure" })).toBe(false);
  expect(isClaudeHookInput({ ...common, hook_event_name: "Notification" })).toBe(false);
});

test("C-HOOK-20 prefers rejection details, then a named error, never assistant text", () => {
  const event = {
    ...common,
    error: "rate_limit",
    error_details: "Please wait.",
    last_assistant_message: "unrelated",
  };
  expect(stopFailureDiagnostic(event)).toEqual({ message: "Please wait.", info: "rate_limit" });
  expect(summarizeHookEvent(event)).toBe("hook StopFailure: Please wait.");
  for (const error_details of ["", " \n\t ", null, 42]) {
    expect(stopFailureDiagnostic({ ...event, error_details })).toEqual({
      message: "Claude rejected the turn: rate_limit",
      info: "rate_limit",
    });
  }
  expect(stopFailureDiagnostic({ error: "   " })).toEqual({ message: "Claude rejected the turn." });
});

test("C-HOOK-20 bounds each diagnostic before composing the result", () => {
  const long = "x".repeat(2_001);
  expect(stopFailureDiagnostic({ error: long }).info).toBe(`${long.slice(0, 2_000)}…`);
  expect(stopFailureDiagnostic({ error: long }).message).toBe(
    `Claude rejected the turn: ${long.slice(0, 2_000)}…`,
  );
  expect(stopFailureDiagnostic({ error_details: long }).message).toBe(`${long.slice(0, 2_000)}…`);
  expect(stopFailureDiagnostic({ error_details: "x".repeat(2_000) }).message).toBe(
    "x".repeat(2_000),
  );
});
