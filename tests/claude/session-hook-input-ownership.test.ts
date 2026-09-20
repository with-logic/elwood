/** Incoming hook observation cannot change routing or nested inputs (C-HOOK-22). */
import { afterEach, expect, test } from "vitest";
import { isRecord } from "../../src/core/predicates.ts";
import { startClaude } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

test.each(["hook", "activity"] as const)("C-HOOK-22 %s cannot reroute Stop", async (channel) => {
  installFakes();
  const cwd = tempDir();
  const session = await startClaude({
    cwd,
    hooks: { Stop: () => ({ decision: "block", reason: "wait" }) },
  });
  await session.sendPrompt("busy");
  let observed = 0;
  session.on(channel, (payload) => {
    const event = "hook_event_name" in payload ? payload : payload.raw;
    if (!isRecord(event) || event["hook_event_name"] !== "Stop") return;
    observed += 1;
    Reflect.set(event, "hook_event_name", "SessionEnd");
  });
  const result = await ptys[0]!.dispatchHook(session.elwoodSessionId, {
    hook_event_name: "Stop",
    session_id: "claude-1",
    cwd,
  });
  expect(observed).toBe(1);
  expect(result.stdout).toBe('{"decision":"block","reason":"wait"}\n');
  expect(session.status).toBe("running");
});

test("C-HOOK-22 hook and activity observers cannot rewrite nested tool input", async () => {
  installFakes();
  const cwd = tempDir();
  const received: unknown[] = [];
  const session = await startClaude({
    cwd,
    hooks: {
      PreToolUse: {
        Bash: (event) => {
          received.push(event.tool_input);
          return { permissionDecision: "deny", updatedInput: { command: "safe" } };
        },
      },
    },
  });
  session.on("hook", (event) => {
    if (event.hook_event_name !== "PreToolUse") return;
    Reflect.set(event, "tool_name", "Read");
    Reflect.set(event.tool_input, "command", "hook mutation");
  });
  session.on("activity", (event) => {
    if (event.kind !== "hook" || !isRecord(event.raw)) return;
    const input = event.raw["tool_input"];
    if (isRecord(input)) Reflect.set(input, "command", "activity mutation");
  });
  const result = await ptys[0]!.dispatchHook(session.elwoodSessionId, {
    hook_event_name: "PreToolUse",
    session_id: "claude-1",
    cwd,
    tool_name: "Bash",
    tool_input: { command: "original" },
  });
  expect(received).toEqual([{ command: "original" }]);
  expect(JSON.parse(result.stdout)).toEqual({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      updatedInput: { command: "safe" },
    },
  });
});
