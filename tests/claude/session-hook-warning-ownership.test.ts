/** Diagnostic observers cannot corrupt captured hook decisions (C-HOOK-22). */
import { afterEach, expect, test } from "vitest";
import { startClaude } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

test("C-HOOK-22 warning mutation cannot replace a validated Stop decision", async () => {
  installFakes();
  const cwd = tempDir();
  const session = await startClaude({
    cwd,
    hooks: { Stop: () => ({ decision: "block", reason: "wait" }) },
  });
  await session.sendPrompt("busy");
  const warnings: unknown[] = [];
  const activities: unknown[] = [];
  session.on("hook", () => {
    throw new Error("observer");
  });
  session.on("warning", (warning) => {
    Object.defineProperty(warning, "code", {
      get() {
        throw new Error("mutated diagnostic");
      },
    });
  });
  session.on("warning", (warning) => warnings.push(warning));
  session.on("activity", (event) => {
    if (event.kind === "warning") activities.push(event);
  });
  const result = await ptys[0]!.dispatchHook(session.elwoodSessionId, {
    hook_event_name: "Stop",
    session_id: "claude-1",
    cwd,
  });
  expect(result.stdout).toBe('{"decision":"block","reason":"wait"}\n');
  expect(session.status).toBe("running");
  expect(warnings).toHaveLength(1);
  expect(Object.isFrozen(warnings[0])).toBe(true);
  expect(activities).toHaveLength(1);
});
