/** Drifted rejection hooks cross the actual socket bridge and reach handlers (C-HOOK-20). */
import { afterEach, expect, test } from "vitest";
import type { ClaudeHookEventFor } from "../../src/index.ts";
import { startClaude } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

test.each([
  {},
  { error: null, error_details: null, last_assistant_message: null },
  { error: { code: "rate_limit" }, error_details: { text: "rejected" }, last_assistant_message: 7 },
])("C-HOOK-20 bridge delivers drifted StopFailure diagnostics: %j", async (fields) => {
  installFakes();
  const cwd = tempDir();
  const seen: ClaudeHookEventFor<"StopFailure">[] = [];
  const errors: string[] = [];
  const session = await startClaude({
    cwd,
    hooks: {
      StopFailure: (event) => {
        seen.push(event);
      },
    },
  });
  session.on("hookError", (event) => errors.push(event.category));
  const input = { hook_event_name: "StopFailure", session_id: "claude-1", cwd, ...fields };
  try {
    const reply = await ptys[0]!.dispatchHook(session.elwoodSessionId, input);
    expect(reply).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(seen).toEqual([input]);
    expect(errors).toEqual([]);
  } finally {
    await session.teardown();
  }
});
