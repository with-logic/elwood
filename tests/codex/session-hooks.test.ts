/**
 * Conformance tests for Codex hook routing and typed responses.
 * Covers PRD §7A.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { startCodex } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

describe("CodexSession hook handling", () => {
  test("C-HOOK-12 C-HOOK-15 fails open and marks ready on unblocked Stop", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd });
    const statuses: string[] = [];
    session.on("status", (event) => statuses.push(event.status));
    const result = await ptys[0]!.dispatchHook(session.elwoodSessionId, stopEvent(cwd));
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(session.status).toBe("ready");
    expect(statuses).toEqual(["ready"]);
  });

  test("C-HRESP-09 blocked Stop keeps Codex running", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({
      cwd,
      hooks: { Stop: () => ({ decision: "block", reason: "Run tests again." }) },
    });
    const result = await ptys[0]!.dispatchHook(session.elwoodSessionId, stopEvent(cwd));
    expect(JSON.parse(result.stdout).decision).toBe("block");
    expect(session.status).toBe("running");
  });

  test("C-HRESP-07 serializes Codex PreToolUse deny and rewritten input", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({
      cwd,
      hooks: {
        PreToolUse: (event) =>
          event.tool_name === "Bash"
            ? { permissionDecision: "deny", permissionDecisionReason: "No destructive shell." }
            : { permissionDecision: "allow", updatedInput: { command: "echo rewritten" } },
      },
    });
    const result = await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      ...toolEvent(cwd),
      tool_name: "Bash",
      tool_input: { command: "rm -rf build" },
    });
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("C-HRESP-07 serializes Codex PreToolUse additional context", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({
      cwd,
      hooks: { PreToolUse: () => ({ additionalContext: "Prefer safe shell commands." }) },
    });
    const result = await ptys[0]!.dispatchHook(session.elwoodSessionId, toolEvent(cwd));
    expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toBe(
      "Prefer safe shell commands.",
    );
  });

  test("C-HRESP-08 serializes Codex PermissionRequest decisions", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({
      cwd,
      hooks: { PermissionRequest: () => ({ behavior: "deny", message: "blocked" }) },
    });
    const result = await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      ...toolEvent(cwd),
      hook_event_name: "PermissionRequest",
    });
    expect(JSON.parse(result.stdout).hookSpecificOutput.decision).toMatchObject({
      behavior: "deny",
      message: "blocked",
    });
  });

  test("C-HOOK-13 emits hookError and fails open on invalid Codex handler result", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({
      cwd,
      hooks: { PermissionRequest: () => ({ updatedInput: {} }) as never },
    });
    const errors: string[] = [];
    session.on("hookError", (event) => errors.push(event.category));
    const result = await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      ...toolEvent(cwd),
      hook_event_name: "PermissionRequest",
    });
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(errors).toEqual(["invalid_response"]);
  });

  test("C-HOOK Codex hook errors fail open on timeout and thrown errors", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({
      cwd,
      hookTimeoutMs: 1,
      hooks: {
        UserPromptSubmit: () => {
          throw new Error("handler exploded");
        },
        PostCompact: () => new Promise(() => {}),
      },
    });
    const errors: string[] = [];
    session.on("hookError", (event) => errors.push(`${event.category}:${event.message}`));
    await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "UserPromptSubmit",
      session_id: "codex-1",
      cwd,
      model: "gpt-5.3-codex",
      turn_id: "turn-1",
      prompt: "hello",
    });
    await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "PostCompact",
      session_id: "codex-1",
      cwd,
      model: "gpt-5.3-codex",
      turn_id: "turn-1",
      trigger: "manual",
    });
    expect(errors).toEqual(["handler_error:handler exploded", "timeout:timeout"]);
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

function toolEvent(cwd: string) {
  return {
    hook_event_name: "PreToolUse",
    session_id: "codex-1",
    cwd,
    model: "gpt-5.3-codex",
    turn_id: "turn-1",
    tool_use_id: "tool-1",
    tool_name: "apply_patch",
    tool_input: { command: "apply patch" },
  };
}
