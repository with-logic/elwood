/**
 * Conformance tests for Claude hook and startup error handling.
 * Covers PRD §8 and §10.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  ElwoodError,
  setCommandRunnerForTests,
  setHookBridgeFactoryForTests,
  setPlatformForTests,
  setPtyFactoryForTests,
  startClaude,
} from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

describe("ClaudeSession errors", () => {
  test("C-HOOK-05 emits hookError and fails open on malformed hook input", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    const errors: string[] = [];
    const offError = session.on("hookError", (event) => errors.push(event.category));
    const result = await ptys[0]!.dispatchMalformedHook(session.elwoodSessionId);
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(errors).toEqual(["invalid_input"]);
    offError();
  });

  test("C-HOOK-05 emits hookError and fails open on thrown handler errors", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({
      cwd,
      hooks: {
        UserPromptSubmit: () => {
          throw new Error("handler exploded");
        },
      },
    });
    const errors: string[] = [];
    session.on("hookError", (event) => errors.push(`${event.category}:${event.message}`));
    const result = await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "UserPromptSubmit",
      session_id: "claude-1",
      cwd,
      prompt: "hello",
    });
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(errors).toEqual(["handler_error:handler exploded"]);
  });

  test("C-HOOK-06 emits hookError and fails open on invalid handler results", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({
      cwd,
      hooks: { Notification: () => ({ decision: "block", reason: "invalid" }) as never },
    });
    const errors: string[] = [];
    session.on("hookError", (event) => errors.push(event.category));
    const result = await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "Notification",
      session_id: "claude-1",
      cwd,
    });
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(errors).toEqual(["invalid_response"]);
  });

  test("C-ERR-02 unsupported platforms fail with typed error", async () => {
    installFakes();
    setPlatformForTests("linux");
    await expect(startClaude({ cwd: tempDir() })).rejects.toMatchObject({
      code: "unsupported_platform",
    });
  });

  test("C-ERR-01 missing Claude fails with typed error", async () => {
    installFakes();
    setCommandRunnerForTests(() => ({
      status: null,
      stdout: "",
      stderr: "",
      error: { code: "ENOENT", message: "missing" },
    }));
    await expect(startClaude({ cwd: tempDir() })).rejects.toBeInstanceOf(ElwoodError);
  });

  test("C-ERR-05 PTY startup failure is typed", async () => {
    installFakes();
    setPtyFactoryForTests(() => {
      throw new Error("pty failed");
    });
    await expect(startClaude({ cwd: tempDir() })).rejects.toMatchObject({
      code: "pty_start_failed",
    });
  });

  test("C-ERR-06 hook bridge startup failure is typed", async () => {
    installFakes();
    setHookBridgeFactoryForTests(() => ({
      start: () => Promise.reject(new Error("bridge failed")),
      stop: () => Promise.resolve(),
    }));
    await expect(startClaude({ cwd: tempDir() })).rejects.toMatchObject({
      code: "hook_bridge_failed",
    });
  });
});
