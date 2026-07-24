/**
 * Real Codex hook bridge e2e flow.
 * Implements C-E2E-01 and C-E2E-03.
 */

import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { type CodexHookHandlers, type CodexSessionApi, startCodex } from "../../src/index.ts";
import {
  assertJson,
  codexToolEvent,
  commandFromToolInput,
  hasHookError,
  type JsonObject,
} from "./bridge-helpers.ts";
import {
  cleanup,
  e2eTimeoutMs,
  invokeHookBridge,
  makeProject,
  observeSession,
  skipReason,
  waitFor,
} from "./helpers.ts";

test("C-E2E-03 real Codex bridge handles typed hook responses", {
  skip: skipReason("codex"),
  timeout: e2eTimeoutMs,
}, async () => {
  const project = makeProject("codex");
  let session: CodexSessionApi | undefined;
  const transcript = join(project.cwd, "codex-transcript.jsonl");
  writeFileSync(transcript, "");
  const hooks: CodexHookHandlers = {
    PreToolUse: {
      Bash: (event) =>
        commandFromToolInput(event.tool_input).includes("context")
          ? { additionalContext: "tool context" }
          : { permissionDecision: "allow", updatedInput: { command: "echo updated" } },
      apply_patch: () => ({
        permissionDecision: "allow",
        updatedInput: { command: "echo updated" },
      }),
    },
    PermissionRequest: () => ({ behavior: "deny", message: "blocked" }),
    PostToolUse: () => undefined,
    UserPromptSubmit: () => undefined,
    SubagentStart: () => undefined,
    SubagentStop: () => ({ decision: "block", reason: "subagent blocked" }),
    PostCompact: () => undefined,
    Stop: () => ({ continue: false, stopReason: "not ready" }),
  };
  try {
    session = await startCodex({
      cwd: project.cwd,
      stateDir: project.stateDir,
      autotrust: true,
      hooks,
    });
    const observed = observeSession(session);
    const base = { session_id: "codex-bridge-e2e", cwd: project.cwd, turn_id: "turn-1" };
    await invokeHookBridge(project, session.elwoodSessionId, {
      session_id: "codex-bridge-e2e",
      cwd: project.cwd,
      hook_event_name: "SessionStart",
      source: "startup",
      transcript_path: transcript,
    });
    appendFileSync(
      transcript,
      `${JSON.stringify({ type: "response_item", payload: { type: "reasoning" } })}\n`,
    );
    await waitFor(
      () => (observed.transcripts.length > 0 ? true : undefined),
      "Codex transcript",
      15_000,
    );
    await expectCodex(
      session,
      codexToolEvent(base, "PreToolUse", "echo ok"),
      ["hookSpecificOutput", "permissionDecision"],
      "allow",
    );
    await expectCodex(
      session,
      codexToolEvent(base, "PreToolUse", "context"),
      ["hookSpecificOutput", "additionalContext"],
      "tool context",
    );
    await expectCodex(
      session,
      codexToolEvent(base, "PermissionRequest", "echo ok"),
      ["hookSpecificOutput", "decision", "message"],
      "blocked",
    );
    assert.deepEqual(
      await invokeHookBridge(
        project,
        session.elwoodSessionId,
        codexToolEvent(base, "PostToolUse", "echo ok"),
      ),
      { status: 0, stdout: "", stderr: "" },
    );
    assert.deepEqual(
      await invokeHookBridge(project, session.elwoodSessionId, {
        ...base,
        hook_event_name: "UserPromptSubmit",
        prompt: "hello",
      }),
      { status: 0, stdout: "", stderr: "" },
    );
    await expectCodex(
      session,
      { ...base, hook_event_name: "Stop", stop_hook_active: false },
      ["continue"],
      false,
    );
    await invokeHookBridge(project, session.elwoodSessionId, {
      ...base,
      hook_event_name: "SubagentStart",
      agent_id: "agent-1",
      agent_type: "general-purpose",
    });
    assert.ok(observed.hooks.some((event) => hookName(event) === "SubagentStart"));
    await expectCodex(
      session,
      {
        ...base,
        hook_event_name: "SubagentStop",
        agent_id: "agent-1",
        agent_type: "general-purpose",
        stop_hook_active: false,
      },
      ["decision"],
      "block",
    );
    await invokeHookBridge(project, session.elwoodSessionId, {
      ...base,
      hook_event_name: "PostCompact",
      trigger: "manual",
    });
    assert.ok(observed.hooks.some((event) => hookName(event) === "PostCompact"));
    session.on("hook:PreCompact", () => ({ invalid: true }) as never);
    await invokeHookBridge(project, session.elwoodSessionId, {
      ...base,
      hook_event_name: "PreCompact",
      trigger: "manual",
    });
    await waitFor(
      () => (hasHookError(observed.hookErrors, "PreCompact") ? true : undefined),
      "Codex invalid hook error",
      15_000,
    );
  } finally {
    await cleanup(session);
  }

  async function expectCodex(
    active: CodexSessionApi,
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

function hookName(event: unknown): string | undefined {
  return event && typeof event === "object"
    ? ((event as { readonly hook_event_name?: unknown }).hook_event_name as string | undefined)
    : undefined;
}
