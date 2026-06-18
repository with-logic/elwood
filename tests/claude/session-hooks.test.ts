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
    const results: unknown[] = [];
    session.on("activity", (event) => {
      if (event.kind === "hook_result") results.push(event.raw);
    });
    const result = await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "UserPromptSubmit",
      session_id: "claude-1",
      cwd,
      prompt: "hi",
    });
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(results[0]).toMatchObject({ hookEventName: "UserPromptSubmit", failedOpen: true });
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

  test("C-API-02 C-HRESP-03 C-HOOK-11 does not mark ready when Stop is blocked", async () => {
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

  test("C-HOOK-02 routes hook invocations to the owning Elwood session", async () => {
    const cwd = tempDir();
    const seen: string[] = [];
    installFakes();
    const first = await startClaude({
      cwd,
      hooks: { UserPromptSubmit: () => void seen.push("first") },
    });
    const second = await startClaude({
      cwd,
      hooks: { UserPromptSubmit: () => void seen.push("second") },
    });
    await ptys[0]!.dispatchHook(first.elwoodSessionId, {
      hook_event_name: "UserPromptSubmit",
      session_id: "claude-1",
      cwd,
      prompt: "one",
    });
    await ptys[1]!.dispatchHook(second.elwoodSessionId, {
      hook_event_name: "UserPromptSubmit",
      session_id: "claude-2",
      cwd,
      prompt: "two",
    });
    expect(seen).toEqual(["first", "second"]);
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

  test("C-HRESP-02 answers AskUserQuestion through updated input", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({
      cwd,
      hooks: {
        PreToolUse: () => ({
          permissionDecision: "allow",
          updatedInput: { answers: [{ questionId: "q1", answer: "yes" }] },
        }),
      },
    });
    const result = await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "PreToolUse",
      session_id: "claude-1",
      cwd,
      tool_name: "AskUserQuestion",
      tool_input: { questions: [{ id: "q1", prompt: "Proceed?" }] },
    });
    expect(JSON.parse(result.stdout).hookSpecificOutput.updatedInput.answers[0].answer).toBe("yes");
  });

  test("C-HRESP-05 serializes typed Elicitation response shapes", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({
      cwd,
      hooks: { Elicitation: () => ({ action: "accept", content: { value: "ok" } }) },
    });
    const result = await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "Elicitation",
      session_id: "claude-1",
      cwd,
      mcp_server_name: "linear",
      message: "Need input",
    });
    expect(JSON.parse(result.stdout).hookSpecificOutput.action).toBe("accept");
  });

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
