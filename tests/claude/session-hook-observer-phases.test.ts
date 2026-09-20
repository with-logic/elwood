/** First observer failure and notification channel diagnostics (C-HOOK-22). */
import { afterEach, expect, test } from "vitest";
import { startClaude } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

test("C-HOOK-22 hook-error activity rejection is classified as activity", async () => {
  installFakes();
  const cwd = tempDir();
  const session = await startClaude({
    cwd,
    hooks: {
      Stop: () => {
        throw new Error("handler");
      },
    },
  });
  const warnings: unknown[] = [];
  session.on("warning", (event) => warnings.push(event));
  session.on("activity", (event) => {
    if (event.kind === "hook_error") throw new Error("observer");
  });
  const result = await ptys[0]!.dispatchHook(session.elwoodSessionId, {
    hook_event_name: "Stop",
    session_id: "claude-1",
    cwd,
  });
  expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  expect(warnings).toEqual([
    expect.objectContaining({ code: "hook_observer_failed", phase: "activity" }),
  ]);
});

test("C-HOOK-22 mixed observer failures preserve the first phase and validated block", async () => {
  installFakes();
  const cwd = tempDir();
  const session = await startClaude({
    cwd,
    hooks: { Stop: () => ({ decision: "block", reason: "wait" }) },
  });
  const warnings: unknown[] = [];
  session.on("warning", (event) => warnings.push(event));
  session.on("hook", () => {
    throw new Error("first");
  });
  session.on("activity", () => {
    throw new Error("second");
  });
  const result = await ptys[0]!.dispatchHook(session.elwoodSessionId, {
    hook_event_name: "Stop",
    session_id: "claude-1",
    cwd,
  });
  expect(result.stdout).toBe('{"decision":"block","reason":"wait"}\n');
  expect(warnings).toEqual([
    expect.objectContaining({ code: "hook_observer_failed", phase: "hook" }),
  ]);
});

test("C-HOOK-22 bridge-error observers cannot skip the diagnostic activity", async () => {
  installFakes();
  const cwd = tempDir();
  const session = await startClaude({ cwd });
  const warnings: unknown[] = [];
  const activity: string[] = [];
  session.on("warning", (event) => warnings.push(event));
  session.on("activity", (event) => activity.push(event.kind));
  session.on("hookError", () => {
    throw new Error("private observer failure");
  });
  const result = await ptys[0]!.dispatchHook(session.elwoodSessionId, {
    hook_event_name: "PreToolUse",
    session_id: "claude-1",
    cwd,
    tool_name: "TaskGet",
    tool_input: {},
  });
  expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  expect(activity).toEqual(["hook_error", "warning"]);
  expect(warnings).toEqual([
    expect.objectContaining({ code: "hook_observer_failed", phase: "hook_error" }),
  ]);
});
