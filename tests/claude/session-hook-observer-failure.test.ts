/** Observer failures cannot erase validated Claude decisions or lifecycle (PRD §6.4). */
import { afterEach, expect, test } from "vitest";
import { startClaude } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

test("C-HOOK-22 a throwing hook-result observer preserves permission response bytes", async () => {
  installFakes();
  const cwd = tempDir();
  const session = await startClaude({
    cwd,
    hooks: {
      PreToolUse: {
        Bash: () => ({ permissionDecision: "deny", updatedInput: { command: "safe" } }),
      },
    },
  });
  session.on("activity", (event) => {
    if (event.kind === "hook_result") throw new Error("private observer failure");
  });
  const result = await ptys[0]!.dispatchHook(session.elwoodSessionId, {
    hook_event_name: "PreToolUse",
    session_id: "claude-1",
    cwd,
    tool_name: "Bash",
    tool_input: { command: "original" },
  });
  expect(result.stdout).toBe(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        updatedInput: { command: "safe" },
      },
    })}\n`,
  );
});

test("C-HOOK-22 a throwing hook-result observer cannot skip Stop lifecycle", async () => {
  installFakes();
  const cwd = tempDir();
  const session = await startClaude({ cwd });
  await session.sendPrompt("busy");
  session.on("activity", (event) => {
    if (event.kind === "hook_result") throw new Error("private observer failure");
  });
  await ptys[0]!.dispatchHook(session.elwoodSessionId, {
    hook_event_name: "Stop",
    session_id: "claude-1",
    cwd,
  });
  expect(session.status).toBe("ready");
});

test.each([
  "hook",
  "activity",
  "status",
] as const)("C-HOOK-22 a throwing %s observer cannot skip Stop bookkeeping", async (channel) => {
  installFakes();
  const cwd = tempDir();
  const session = await startClaude({ cwd });
  await session.sendPrompt("busy");
  const warnings: unknown[] = [];
  const warningActivity: string[] = [];
  session.on("warning", () => {
    throw new Error("private warning sink");
  });
  session.on("warning", (event) => warnings.push(event));
  session.on("activity", (event) => {
    if (event.kind === "warning") warningActivity.push(event.label);
  });
  session.on(channel, () => {
    throw new Error("private observer failure");
  });
  const result = await ptys[0]!.dispatchHook(session.elwoodSessionId, {
    hook_event_name: "Stop",
    session_id: "claude-1",
    cwd,
  });
  expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  expect(session.status).toBe("ready");
  expect(warnings).toEqual([
    expect.objectContaining({
      code: "hook_observer_failed",
      phase: channel === "status" ? "lifecycle" : channel,
    }),
  ]);
  expect(JSON.stringify(warnings)).not.toContain("private");
  expect(warningActivity).toEqual(["hook_observer_failed"]);
});

test("C-HOOK-22 blocked Stop remains blocked despite result-observer failure", async () => {
  installFakes();
  const cwd = tempDir();
  const session = await startClaude({
    cwd,
    hooks: { Stop: () => ({ decision: "block", reason: "still working" }) },
  });
  await session.sendPrompt("busy");
  session.on("activity", (event) => {
    if (event.kind === "hook_result") throw new Error("private observer failure");
  });
  const result = await ptys[0]!.dispatchHook(session.elwoodSessionId, {
    hook_event_name: "Stop",
    session_id: "claude-1",
    cwd,
  });
  expect(JSON.parse(result.stdout)).toEqual({ decision: "block", reason: "still working" });
  expect(session.status).toBe("running");
});

test("C-HOOK-22 a throwing hookError observer preserves fail-open lifecycle", async () => {
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
  await session.sendPrompt("busy");
  const warnings: unknown[] = [];
  session.on("warning", (event) => warnings.push(event));
  session.on("hookError", () => {
    throw new Error("private observer failure");
  });
  const result = await ptys[0]!.dispatchHook(session.elwoodSessionId, {
    hook_event_name: "Stop",
    session_id: "claude-1",
    cwd,
  });
  expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  expect(session.status).toBe("ready");
  expect(warnings).toEqual([
    expect.objectContaining({ code: "hook_observer_failed", phase: "hook_error" }),
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
