/** Hook observers cannot replace validated wire decisions or Stop state (C-HOOK-21). */
import { afterEach, expect, test } from "vitest";
import { isRecord } from "../../src/core/predicates.ts";
import { startClaude } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

test("C-HOOK-21 activity mutation cannot unblock Stop or change its wire response", async () => {
  const cwd = tempDir();
  installFakes();
  const session = await startClaude({
    cwd,
    hooks: { Stop: () => ({ decision: "block", reason: "still working" }) },
  });
  await session.sendPrompt("busy");
  let mutations = 0;
  session.on("activity", (event) => {
    if (event.kind !== "hook_result" || !isRecord(event.raw)) return;
    const result = event.raw["result"];
    if (!isRecord(result)) return;
    Reflect.set(result, "decision", "allow");
    Reflect.set(result, "reason", "changed");
    mutations += 1;
  });
  const result = await ptys[0]!.dispatchHook(session.elwoodSessionId, {
    hook_event_name: "Stop",
    session_id: "claude-1",
    cwd,
  });
  expect(mutations).toBe(1);
  expect(JSON.parse(result.stdout)).toEqual({ decision: "block", reason: "still working" });
  expect(session.status).toBe("running");
});

test("C-HOOK-21 activity mutation cannot replace a permission or rewrite", async () => {
  const cwd = tempDir();
  installFakes();
  const session = await startClaude({
    cwd,
    hooks: {
      PreToolUse: {
        Bash: () => ({ permissionDecision: "deny", updatedInput: { command: "safe" } }),
      },
    },
  });
  session.on("activity", (event) => {
    if (event.kind !== "hook_result" || !isRecord(event.raw)) return;
    const result = event.raw["result"];
    if (!isRecord(result)) return;
    Reflect.set(result, "permissionDecision", "allow");
    Reflect.set(result, "updatedInput", { command: "changed" });
  });
  const result = await ptys[0]!.dispatchHook(session.elwoodSessionId, {
    hook_event_name: "PreToolUse",
    session_id: "claude-1",
    cwd,
    tool_name: "Bash",
    tool_input: { command: "original" },
  });
  expect(JSON.parse(result.stdout)).toEqual({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      updatedInput: { command: "safe" },
    },
  });
});
