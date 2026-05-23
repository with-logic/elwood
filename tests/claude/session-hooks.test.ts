/**
 * Conformance tests for Claude hook routing and typed hook responses.
 * Covers PRD §6, §8, and §10.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { startClaude } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

describe("ClaudeSession hook handling", () => {
  test("C-HOOK-03 fails open when no hook handler is registered", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    const result = await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "UserPromptSubmit",
      session_id: "claude-1",
      cwd,
      prompt: "hi",
    });
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    const statuses: string[] = [];
    const offStatus = session.on("status", (event) => statuses.push(event.status));
    await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "Stop",
      session_id: "claude-1",
      cwd,
    });
    expect(statuses).toEqual(["ready"]);
    expect(session.status).toBe("ready");
    offStatus();
  });

  test("C-HOOK-11 does not mark ready when Stop is blocked", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({
      cwd,
      hooks: { Stop: () => ({ decision: "block", reason: "tests are still failing" }) },
    });
    const result = await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "Stop",
      session_id: "claude-1",
      cwd,
    });
    expect(JSON.parse(result.stdout).decision).toBe("block");
    expect(session.status).toBe("running");
  });

  test("C-HOOK-08 relays typed Stop message fields to handlers", async () => {
    const cwd = tempDir();
    const messages: string[] = [];
    installFakes();
    const session = await startClaude({
      cwd,
      hooks: {
        Stop: (event) => {
          messages.push(event.last_assistant_message ?? "");
          messages.push(event.background_tasks?.[0]?.command ?? "");
          messages.push(event.session_crons?.[0]?.prompt ?? "");
          return undefined;
        },
      },
    });
    await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "Stop",
      session_id: "claude-1",
      cwd,
      last_assistant_message: "I updated the docs.",
      background_tasks: [
        { id: "task-1", type: "shell", status: "running", command: "tail -f log" },
      ],
      session_crons: [{ id: "cron-1", schedule: "0 * * * *", recurring: true, prompt: "check CI" }],
    });
    expect(messages).toEqual(["I updated the docs.", "tail -f log", "check CI"]);
  });

  test("C-HRESP-01 serializes typed PreToolUse denial responses", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({
      cwd,
      hooks: {
        PreToolUse: () => ({
          permissionDecision: "deny",
          permissionDecisionReason: "No database writes",
        }),
      },
    });
    const result = await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "PreToolUse",
      session_id: "claude-1",
      cwd,
      tool_name: "Bash",
      tool_input: { command: "psql" },
    });
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("C-HOOK-04 emits hookError and fails open on timeout", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({
      cwd,
      hookTimeoutMs: 1,
      hooks: { Stop: () => new Promise(() => {}) },
    });
    const errors: string[] = [];
    const offError = session.on("hookError", (event) => errors.push(event.category));
    const result = await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "Stop",
      session_id: "claude-1",
      cwd,
    });
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(errors).toEqual(["timeout"]);
    offError();
  });
});
