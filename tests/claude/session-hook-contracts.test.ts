/** Bridge regressions for concrete input validation and fail-open responses (PRD §6.4). */

import { afterEach, expect, test } from "vitest";
import { startClaude } from "../../src/index.ts";
import { concreteInputs } from "../unit/claude-concrete-tool-fixtures.ts";
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
        TaskGet: () => ({ behavior: "allow", updatedInput: { taskId: 42 } }) as never,
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
    tool_input: { taskId: "task" },
  });
  expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  expect(errors).toEqual(["invalid_response"]);
});

test("C-HOOK-07 C-HRESP-01 native task and plan payloads retain typed rewrites", async () => {
  const cwd = tempDir();
  installFakes();
  const session = await startClaude({
    cwd,
    hooks: {
      PermissionRequest: {
        TaskGet: (event) => ({
          behavior: "allow",
          updatedInput: { taskId: `${event.tool_input.taskId}-next` },
        }),
        TaskOutput: (event) => ({
          behavior: "allow",
          updatedInput: { timeout: event.tool_input.timeout + 1 },
        }),
        TaskStop: () => ({ behavior: "allow", updatedInput: { task_id: "next" } }),
        ExitPlanMode: () => ({
          behavior: "allow",
          updatedInput: { allowedPrompts: [{ tool: "Bash", prompt: "test" }] },
        }),
      },
    },
  });
  const errors: string[] = [];
  session.on("hookError", (event) => errors.push(event.category));
  const rewrites = {
    TaskGet: { taskId: "task-next" },
    TaskOutput: { timeout: 1001 },
    TaskStop: { task_id: "next" },
    ExitPlanMode: { allowedPrompts: [{ tool: "Bash", prompt: "test" }] },
  };
  for (const name of Object.keys(rewrites) as (keyof typeof rewrites)[]) {
    const result = await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "PermissionRequest",
      session_id: "claude-1",
      cwd,
      tool_name: name,
      tool_input: concreteInputs[name],
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      hookSpecificOutput: { decision: { updatedInput: rewrites[name] } },
    });
  }
  expect(errors).toEqual([]);
});
