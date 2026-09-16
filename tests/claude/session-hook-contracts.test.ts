/** Bridge regressions for concrete input validation and fail-open responses (PRD §6.4). */

import { afterEach, expect, test } from "vitest";
import { startClaude } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

test("C-HOOK-07 prevents malformed concrete inputs from reaching handlers", async () => {
  const cwd = tempDir();
  installFakes();
  let calls = 0;
  const session = await startClaude({
    cwd,
    hooks: {
      PreToolUse: () => {
        calls++;
        return undefined;
      },
    },
  });
  const errors: string[] = [];
  session.on("hookError", (event) => errors.push(event.category));
  const result = await ptys[0]!.dispatchHook(session.elwoodSessionId, {
    hook_event_name: "PreToolUse",
    session_id: "claude-1",
    cwd,
    tool_name: "TaskGet",
    tool_input: {},
  });
  expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  expect(calls).toBe(0);
  expect(errors).toEqual(["invalid_input"]);
});

test("C-HRESP-01 malformed ID rewrites fail open before reaching Claude", async () => {
  const cwd = tempDir();
  installFakes();
  const session = await startClaude({
    cwd,
    hooks: {
      PermissionRequest: {
        TaskGet: () => ({ behavior: "allow", updatedInput: { id: 42 } }) as never,
      },
    },
  });
  const errors: string[] = [];
  session.on("hookError", (event) => errors.push(event.category));
  const result = await ptys[0]!.dispatchHook(session.elwoodSessionId, {
    hook_event_name: "PermissionRequest",
    session_id: "claude-1",
    cwd,
    tool_name: "TaskGet",
    tool_input: { id: "task" },
  });
  expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  expect(errors).toEqual(["invalid_response"]);
});
