/**
 * Conformance tests for Codex hook dispatch edge cases.
 * Covers PRD §7A.
 */

import { afterEach, describe, expect, test } from "vitest";
import { startCodex } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

describe("CodexSession hook dispatch edges", () => {
  test("C-HRESP-09 continue:false Stop results keep Codex running", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({
      cwd,
      hooks: { Stop: () => ({ continue: false, stopReason: "Verify output first." }) },
    });
    await session.sendPrompt("busy");
    const result = await ptys[0]!.dispatchHook(session.elwoodSessionId, stopEvent(cwd));
    expect(JSON.parse(result.stdout)).toMatchObject({
      continue: false,
      stopReason: "Verify output first.",
    });
    expect(session.status).toBe("running");
  });

  test("C-HOOK-05 non-Error handler failures fail open with a generic message", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({
      cwd,
      hooks: { Stop: () => Promise.reject("string failure") },
    });
    const errors: string[] = [];
    session.on("hookError", (event) => errors.push(`${event.category}:${event.message}`));
    const result = await ptys[0]!.dispatchHook(session.elwoodSessionId, stopEvent(cwd));
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(errors).toEqual(["handler_error:Hook handler failed"]);
    expect(session.status).toBe("ready");
  });
});

function stopEvent(cwd: string) {
  return {
    hook_event_name: "Stop",
    session_id: "codex-1",
    cwd,
    model: "gpt-5.3-codex",
    turn_id: "turn-1",
    stop_hook_active: false,
  };
}
