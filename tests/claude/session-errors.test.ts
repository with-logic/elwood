/**
 * Conformance tests for Claude hook and startup error handling.
 * Covers PRD §8 and §10.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { setHookBridgeFactoryForTests } from "../../src/claude/session.ts";
import { ElwoodError, startClaude } from "../../src/index.ts";
import {
  setCommandRunnerForTests,
  setPlatformForTests,
  setPtyFactoryForTests,
} from "../../src/runtime/seams.ts";
import { FakePty, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

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
      message: "notice",
      notification_type: "info",
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

  test("C-CLAUDE-05 C-ERR-01 missing Claude fails with typed error", async () => {
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

  test("C-CLAUDE-06 C-ERR-01 startup exits stop local resources", async () => {
    const cwd = tempDir();
    installFakes();
    setPtyFactoryForTests((options) => {
      const pty = new FakePty(options);
      ptys.push(pty);
      const timer = setInterval(() => {
        if (pty.exitHandlers.length === 0) return;
        clearInterval(timer);
        pty.emitExit({ exitCode: 12, signal: 15 });
      }, 0);
      return pty;
    });
    await expect(startClaude({ cwd })).rejects.toMatchObject({ code: "claude_start_failed" });
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
