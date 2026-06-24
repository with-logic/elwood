/**
 * Conformance tests for Claude hook handler failure behavior.
 * Covers PRD §6 and §10.
 */

import { afterEach, describe, expect, test } from "vitest";
import { startClaude } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

describe("ClaudeSession hook errors", () => {
  test("C-API-17 C-HOOK-04 emits hookError and fails open on timeout", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({
      cwd,
      hookTimeoutMs: 1,
      hooks: { Stop: () => new Promise(() => {}) },
    });
    const errors: string[] = [];
    const activity: string[] = [];
    const offError = session.on("hookError", (event) => errors.push(event.category));
    session.on("activity", (event) => activity.push(event.kind));
    const result = await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "Stop",
      session_id: "claude-1",
      cwd,
    });
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(errors).toEqual(["timeout"]);
    expect(activity).toContain("hook_error");
    offError();
  });
});
