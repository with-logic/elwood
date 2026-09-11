/**
 * Conformance tests for Claude hook and startup error handling.
 * Covers PRD §8 and §10.
 */

import { afterEach, describe, expect, test } from "vitest";
import { setHookBridgeFactoryForTests } from "../../src/claude/session/index.ts";
import { startClaude } from "../../src/index.ts";
import {
  setCommandRunnerForTests,
  setPlatformForTests,
  setPtyFactoryForTests,
} from "../../src/runtime/seams.ts";
import { FakePty, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

describe("ClaudeSessionApi errors", () => {
  test("C-HOOK-07 C-HOOK-16 emits hookError and fails open on malformed hook input", async () => {
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

  test("C-CLAUDE-20 an out-of-enum reasoningEffort rejects before spawn", async () => {
    installFakes();
    await expect(
      // `ultra` is a Codex-only-ish value, never valid for Claude's --effort enum.
      startClaude({ cwd: tempDir(), reasoningEffort: "ultra" as never }),
    ).rejects.toMatchObject({
      code: "claude_invalid_reasoning_effort",
      message: expect.stringContaining("ultra"),
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
    await expect(startClaude({ cwd: tempDir() })).rejects.toMatchObject({
      code: "claude_not_found",
      message: expect.stringContaining("claude"),
    });
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

  test("C-ERR-05 non-Error PTY factory failures are stringified", async () => {
    installFakes();
    setPtyFactoryForTests(() => {
      throw nonErrorFailure("pty exploded");
    });
    await expect(startClaude({ cwd: tempDir() })).rejects.toMatchObject({
      code: "pty_start_failed",
      details: { cause: "pty exploded" },
    });
  });

  test("C-ERR-06 non-Error hook bridge failures are stringified", async () => {
    installFakes();
    setHookBridgeFactoryForTests(() => ({
      start: () => Promise.reject("bridge exploded"),
      stop: () => Promise.resolve(),
    }));
    await expect(startClaude({ cwd: tempDir() })).rejects.toMatchObject({
      code: "hook_bridge_failed",
      details: { cause: "bridge exploded" },
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

  test("C-LIFE-10 a failure in the guarded startup region tears down the live bridge + PTY", async () => {
    // The guarded region spans the warning flush, exit registration, the startup
    // assertion, and startup evidence — all AFTER the bridge/PTY/terminal are live. A
    // failure in ANY of them (here, the auth-banner assertion) must run cleanup so the
    // now-live bridge is stopped and the PTY killed, never leaked.
    const cwd = tempDir();
    installFakes();
    let bridgeStopped = false;
    setHookBridgeFactoryForTests(() => ({
      start: () => Promise.resolve(),
      stop: () => {
        bridgeStopped = true;
        return Promise.resolve();
      },
    }));
    setPtyFactoryForTests((options) => {
      const pty = new FakePty(options);
      ptys.push(pty);
      queueMicrotask(() => pty.emitData("not authenticated")); // auth banner => region rejects
      return pty;
    });
    await expect(startClaude({ cwd })).rejects.toMatchObject({
      code: "claude_not_authenticated",
    });
    expect(bridgeStopped).toBe(true); // the live bridge was stopped by the region cleanup
    expect(ptys.at(-1)!.killSignals).toContain("SIGTERM"); // the live PTY was signaled
  });
});

function nonErrorFailure(message: string): Error {
  return message as unknown as Error;
}
