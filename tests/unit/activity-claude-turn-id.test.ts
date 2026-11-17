/** Nonempty native Claude hook IDs implement PRD §5.4 / C-CLAUDE-15. */
import { expect, test } from "vitest";
import { activityFromClaudeHook } from "../../src/core/activity/index.ts";

test.each([
  { name: "missing", fields: {}, expected: undefined },
  { name: "empty", fields: { prompt_id: "" }, expected: undefined },
  { name: "native", fields: { prompt_id: "native" }, expected: "native" },
])("C-CLAUDE-15 a $name hook prompt identity projects consistently", ({ fields, expected }) => {
  const event = activityFromClaudeHook("session", {
    hook_event_name: "UserPromptSubmit",
    session_id: "native-session",
    cwd: "/repo",
    prompt: "hello",
    ...fields,
  });
  expect(event.turnId).toBe(expected);
  expect(Object.hasOwn(event, "turnId")).toBe(expected !== undefined);
});
