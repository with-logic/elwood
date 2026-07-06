/**
 * Real tool-use turns, early message queueing, and kill flows.
 * Implements C-E2E-02 and C-E2E-03.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  type ClaudeHookHandlers,
  type ClaudeSession,
  type CodexHookHandlers,
  type CodexSession,
  ElwoodError,
  startClaude,
  startCodex,
} from "../../src/index.ts";
import {
  cleanup,
  e2eTimeoutMs,
  makeProject,
  observeSession,
  pathRemoved,
  skipReason,
  turnsEnabled,
  waitFor,
} from "./helpers.ts";

const skipTurnsReason = turnsEnabled ? undefined : "ELWOOD_E2E_SKIP_TURNS=1 disables turn flows";

type ToolSeen = { readonly name: string; readonly input: unknown; readonly response?: unknown };

test("C-E2E-02 real Claude turn queues early messages and hooks real tools", {
  skip: skipReason("claude") ?? skipTurnsReason,
  timeout: e2eTimeoutMs + 30_000,
}, async () => {
  const project = makeProject("claude");
  let session: ClaudeSession | undefined;
  const prompts: string[] = [];
  const preTools: ToolSeen[] = [];
  const postTools: ToolSeen[] = [];
  let stops = 0;
  let denyTools = false;
  const hooks: ClaudeHookHandlers = {
    UserPromptSubmit: (event) => {
      prompts.push(event.prompt);
    },
    PreToolUse: (event) => {
      preTools.push({ name: event.tool_name, input: event.tool_input });
      if (!denyTools) return undefined;
      return {
        permissionDecision: "deny",
        permissionDecisionReason: "Denied by e2e. Do not retry; reply exactly: ELWOOD_DENY_OK.",
      };
    },
    PostToolUse: (event) => {
      postTools.push({
        name: event.tool_name,
        input: event.tool_input,
        response: event.tool_response,
      });
    },
    Stop: () => {
      stops += 1;
    },
  };
  try {
    session = await startClaude({
      cwd: project.cwd,
      stateDir: project.stateDir,
      initialSize: { cols: 100, rows: 30 },
      permissionMode: "bypassPermissions",
      hookTimeoutMs: 10_000,
      autotrust: true,
      hooks,
    });
    const observed = observeSession(session);
    // Queue the first message before the interactive prompt is ready.
    await session.sendMessage(
      "Use your Read tool to read AGENTS.md.\nThen reply exactly: ELWOOD_TOOL_OK",
    );
    await waitFor(
      () =>
        prompts.some((p) => p.includes("Read tool") && p.includes("ELWOOD_TOOL_OK"))
          ? true
          : undefined,
      "queued multi-line UserPromptSubmit",
    );
    await waitFor(() => (preTools.length > 0 ? true : undefined), "real Claude PreToolUse");
    await waitFor(() => (postTools.length > 0 ? true : undefined), "real Claude PostToolUse");
    const pre = preTools[0];
    const post = postTools[0];
    assert.ok(pre && pre.name.length > 0);
    assert.ok(pre.input && typeof pre.input === "object");
    assert.ok(post && post.name.length > 0);
    assert.notEqual(post.response, undefined);
    await waitFor(() => (stops >= 1 ? true : undefined), "first Claude Stop");
    const replayed: string[] = [];
    session.on("terminal:data", (event) => replayed.push(event.data))();
    assert.ok(replayed.join("").length > 0, "late subscriber receives replayed terminal data");
    denyTools = true;
    const preBefore = preTools.length;
    await session.sendMessage(
      "Run `ls` using your Bash tool. If the tool is blocked, reply exactly: ELWOOD_DENY_OK",
    );
    await waitFor(() => (preTools.length > preBefore ? true : undefined), "denied PreToolUse");
    await waitFor(() => (stops >= 2 ? true : undefined), "second Claude Stop");
    assert.equal(observed.hookErrors.length, 0);
    await session.kill();
    assert.equal(session.status, "killed");
    assert.equal(pathRemoved(project.sessionDir(session.elwoodSessionId)), false);
    const killedClaude = session;
    await assert.rejects(
      async () => killedClaude.sendMessage("late"),
      hasCode("session_not_running"),
    );
    observed.dispose();
  } finally {
    await cleanup(session);
  }
});

test("C-E2E-03 real Codex turn queues early messages and hooks real tools", {
  skip: skipReason("codex") ?? skipTurnsReason,
  timeout: e2eTimeoutMs + 30_000,
}, async () => {
  const project = makeProject("codex");
  let session: CodexSession | undefined;
  const prompts: string[] = [];
  const preTools: ToolSeen[] = [];
  const postTools: ToolSeen[] = [];
  let stops = 0;
  const hooks: CodexHookHandlers = {
    UserPromptSubmit: (event) => {
      prompts.push(event.prompt);
    },
    PreToolUse: (event) => {
      preTools.push({ name: String(event.tool_name), input: event.tool_input });
      return undefined;
    },
    PostToolUse: (event) => {
      postTools.push({ name: String(event.tool_name), input: event.tool_input });
    },
    Stop: () => {
      stops += 1;
    },
  };
  try {
    session = await startCodex({
      cwd: project.cwd,
      stateDir: project.stateDir,
      initialSize: { cols: 100, rows: 30 },
      sandbox: "workspace-write",
      approvalPolicy: "never",
      hookTimeoutMs: 10_000,
      autotrust: true,
      // The persona is delivered by Elwood as the queued first message.
      persona:
        "Run `cat AGENTS.md` with your shell tool.\nThen reply exactly: ELWOOD_CODEX_TOOL_OK",
      hooks,
    });
    const observed = observeSession(session);
    await waitFor(
      () =>
        prompts.some((p) => p.includes("shell tool") && p.includes("ELWOOD_CODEX_TOOL_OK"))
          ? true
          : undefined,
      "persona delivered as first UserPromptSubmit",
    );
    assert.ok(prompts[0]?.includes("ELWOOD_CODEX_TOOL_OK"), "persona is the first prompt");
    await waitFor(() => (preTools.length > 0 ? true : undefined), "real Codex PreToolUse");
    await waitFor(() => (postTools.length > 0 ? true : undefined), "real Codex PostToolUse");
    const pre = preTools[0];
    assert.ok(pre && pre.name.length > 0);
    assert.ok(pre.input && typeof pre.input === "object");
    await waitFor(() => (stops >= 1 ? true : undefined), "Codex Stop");
    const replayed: string[] = [];
    session.on("terminal:data", (event) => replayed.push(event.data))();
    assert.ok(replayed.join("").length > 0, "late subscriber receives replayed terminal data");
    assert.equal(observed.hookErrors.length, 0);
    await session.kill();
    assert.equal(session.status, "killed");
    assert.equal(pathRemoved(project.sessionDir(session.elwoodSessionId)), false);
    const killedCodex = session;
    await assert.rejects(
      async () => killedCodex.sendMessage("late"),
      hasCode("session_not_running"),
    );
    observed.dispose();
  } finally {
    await cleanup(session);
  }
});

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ElwoodError && error.code === code;
}
