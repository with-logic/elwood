/** Public delivery of textless Claude submissions through the authenticated bridge (C-API-62). */
import { afterEach, expect, test } from "vitest";
import { type ClaudeHookEvent, type ElwoodActivityEvent, startClaude } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

test.each([
  {},
  { prompt: null },
])("C-API-62 a textless Claude submit stays observable (%j)", async (fields) => {
  const cwd = tempDir();
  installFakes();
  const session = await startClaude({ cwd });
  const hooks: ClaudeHookEvent[] = [];
  const activities: ElwoodActivityEvent[] = [];
  session.on("hook", (event) => hooks.push(event));
  session.on("activity", (event) => activities.push(event));
  const reply = await ptys[0]!.dispatchHook(session.elwoodSessionId, {
    hook_event_name: "UserPromptSubmit",
    session_id: "claude-1",
    prompt_id: "prompt-1",
    cwd,
    ...fields,
  });
  expect(reply).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  expect(hooks).toEqual([
    expect.objectContaining({ hook_event_name: "UserPromptSubmit", prompt: "" }),
  ]);
  expect(activities.filter(({ kind }) => kind === "hook")).toEqual([
    expect.objectContaining({ turnId: "prompt-1", raw: hooks[0] }),
  ]);
  expect(activities.some(({ kind }) => kind === "user_message" || kind === "hook_error")).toBe(
    false,
  );
});
