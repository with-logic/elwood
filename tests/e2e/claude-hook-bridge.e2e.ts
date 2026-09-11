/**
 * Real Claude hook bridge e2e flow.
 * Implements C-E2E-01 and C-E2E-02.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { type ClaudeHookHandlers, type ClaudeSessionApi, startClaude } from "../../src/index.ts";
import {
  assertJson,
  claudePostToolEvent,
  claudeToolEvent,
  hasHookError,
  type JsonObject,
} from "./bridge-helpers.ts";
import {
  cleanup,
  e2eTimeoutMs,
  invokeHookBridge,
  makeProject,
  observeSession,
  skipIf,
  skipReason,
  waitFor,
} from "./helpers.ts";

test("C-E2E-02 real Claude bridge handles typed hook responses", {
  skip: skipIf(skipReason("claude")),
  timeout: e2eTimeoutMs,
}, async () => {
  const project = makeProject("claude");
  let session: ClaudeSessionApi | undefined;
  const hooks: ClaudeHookHandlers = {
    SessionStart: () => ({ additionalContext: "session context", watchPaths: ["README.md"] }),
    Setup: () => ({ additionalContext: "setup context" }),
    PreToolUse: () => ({ permissionDecision: "deny", permissionDecisionReason: "blocked" }),
    PermissionDenied: () => ({ retry: true }),
    PermissionRequest: () => ({ behavior: "allow", message: "approved" }),
    PostToolUse: () => ({ additionalContext: "tool context", updatedToolOutput: "patched" }),
    UserPromptExpansion: () => ({ decision: "block", reason: "expansion blocked" }),
    TaskCreated: () => ({ continue: false, stopReason: "task blocked" }),
    Stop: () => ({ decision: "block", reason: "not done", additionalContext: "keep going" }),
    TeammateIdle: () => ({ continue: false, stopReason: "idle blocked" }),
    WorktreeCreate: () => ({ worktreePath: join(project.cwd, "worktree") }),
    Elicitation: () => ({ action: "accept", content: { ok: true } }),
    ElicitationResult: () => ({ action: "decline" }),
  };
  try {
    session = await startClaude({
      cwd: project.cwd,
      stateDir: project.stateDir,
      autotrust: true,
      hooks,
    });
    const observed = observeSession(session);
    const base = { session_id: "claude-bridge-e2e", cwd: project.cwd };
    await expectClaude(
      session,
      { ...base, hook_event_name: "SessionStart", source: "startup" },
      ["hookSpecificOutput", "additionalContext"],
      "session context",
    );
    await expectClaude(
      session,
      { ...base, hook_event_name: "Setup", trigger: "init" },
      ["hookSpecificOutput", "additionalContext"],
      "setup context",
    );
    await expectClaude(
      session,
      claudeToolEvent(base, "PreToolUse"),
      ["hookSpecificOutput", "permissionDecision"],
      "deny",
    );
    await expectClaude(
      session,
      { ...claudeToolEvent(base, "PermissionDenied"), tool_use_id: "tool-1", reason: "blocked" },
      ["hookSpecificOutput", "retry"],
      true,
    );
    await expectClaude(
      session,
      claudeToolEvent(base, "PermissionRequest"),
      ["hookSpecificOutput", "decision", "message"],
      "approved",
    );
    await expectClaude(
      session,
      claudePostToolEvent(base),
      ["hookSpecificOutput", "updatedToolOutput"],
      "patched",
    );
    await expectClaude(session, { ...base, hook_event_name: "Stop" }, ["decision"], "block");
    await expectClaude(
      session,
      {
        ...base,
        hook_event_name: "UserPromptExpansion",
        expansion_type: "slash_command",
        command_name: "test",
        prompt: "expanded",
      },
      ["decision"],
      "block",
    );
    await expectClaude(
      session,
      { ...base, hook_event_name: "TaskCreated", task_id: "task-1", task_subject: "work" },
      ["continue"],
      false,
    );
    await expectClaude(
      session,
      {
        ...base,
        hook_event_name: "TeammateIdle",
        teammate_name: "teammate",
        team_name: "team",
      },
      ["continue"],
      false,
    );
    const worktree = await invokeHookBridge(project, session.elwoodSessionId, {
      ...base,
      hook_event_name: "WorktreeCreate",
      name: "feature",
    });
    assert.equal(worktree.stdout, `${join(project.cwd, "worktree")}\n`);
    await expectClaude(
      session,
      {
        ...base,
        hook_event_name: "Elicitation",
        mcp_server_name: "server",
        message: "choose",
      },
      ["hookSpecificOutput", "action"],
      "accept",
    );
    await expectClaude(
      session,
      { ...base, hook_event_name: "ElicitationResult", mcp_server_name: "server", action: "ok" },
      ["hookSpecificOutput", "action"],
      "decline",
    );
    session.on("hook:ConfigChange", () => ({ invalid: true }) as never);
    const invalid = await invokeHookBridge(project, session.elwoodSessionId, {
      ...base,
      hook_event_name: "ConfigChange",
      source: "local",
    });
    assert.equal(invalid.stdout, "");
    await waitFor(
      () => (hasHookError(observed.hookErrors, "ConfigChange") ? true : undefined),
      "Claude invalid hook error",
      15_000,
    );
  } finally {
    await cleanup(session);
  }

  async function expectClaude(
    active: ClaudeSessionApi,
    input: JsonObject,
    path: readonly string[],
    expected: unknown,
  ): Promise<void> {
    assertJson(
      (await invokeHookBridge(project, active.elwoodSessionId, input)).stdout,
      path,
      expected,
    );
  }
});
