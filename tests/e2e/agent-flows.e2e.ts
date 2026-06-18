/**
 * Real public API e2e flows for supported agent adapters.
 * Implements C-E2E-01, C-E2E-02, C-E2E-03, and C-E2E-04.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  type ClaudeHookHandlers,
  type ClaudeSession,
  type CodexHookHandlers,
  type CodexSession,
  resumeClaude,
  resumeCodex,
  startClaude,
  startCodex,
} from "../../src/index.ts";
import {
  cleanup,
  e2eTimeoutMs,
  hasActivity,
  hookNamed,
  makeProject,
  observeSession,
  pathRemoved,
  prepareInteractivePrompt,
  skipReason,
  turnsEnabled,
  waitFor,
} from "./helpers.ts";

test("C-E2E-02 real Claude session supports core public flows", {
  skip: skipReason("claude"),
  timeout: e2eTimeoutMs + 30_000,
}, async () => {
  const project = makeProject("claude");
  let session: ClaudeSession | undefined;
  let resumed: ClaudeSession | undefined;
  const hooksSeen: string[] = [];
  const hooks: ClaudeHookHandlers = {
    SessionStart: (event) => {
      hooksSeen.push(event.hook_event_name);
    },
    UserPromptSubmit: (event) => {
      hooksSeen.push(event.hook_event_name);
    },
    Stop: (event) => {
      hooksSeen.push(event.hook_event_name);
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
    await prepareInteractivePrompt(session, observed, "claude");
    await session.resize({ cols: 101, rows: 31 });
    assert.equal(session.terminal.size.cols, 101);
    assert.equal(session.terminal.size.rows, 31);
    assert.ok(session.elwoodSessionId);
    assert.equal(session.cwd, project.cwd);
    if (!turnsEnabled) {
      await session.teardown();
      assert.equal(session.status, "torn_down");
      assert.equal(pathRemoved(project.sessionDir(session.elwoodSessionId)), true);
      return;
    }
    await session.sendMessage("Reply exactly: ELWOOD_E2E_CLAUDE_OK. Do not use tools.");
    await waitFor(() => hookNamed(observed.hooks, "UserPromptSubmit"), "Claude UserPromptSubmit");
    await waitFor(() => hookNamed(observed.hooks, "Stop"), "Claude Stop hook");
    await waitFor(() => (hasActivity(observed.activities) ? true : undefined), "Claude activity");
    await waitFor(
      () => (hooksSeen.includes("SessionStart") ? true : undefined),
      "Claude SessionStart hook",
    );
    await session.stop();
    assert.equal(session.status, "stopped");
    resumed = await resumeClaude({
      cwd: project.cwd,
      stateDir: project.stateDir,
      elwoodSessionId: session.elwoodSessionId,
      autotrust: true,
      hooks,
    });
    const resumedObserved = observeSession(resumed);
    await resumed.sendKeys("\u001b");
    await waitFor(
      () => (resumedObserved.terminal.join("").length > 0 ? true : undefined),
      "resumed Claude PTY data",
      45_000,
    );
    await resumed.teardown();
    assert.equal(resumed.status, "torn_down");
    assert.equal(pathRemoved(project.sessionDir(session.elwoodSessionId)), true);
  } finally {
    await cleanup(resumed);
    await cleanup(session);
  }
});

test("C-E2E-03 real Codex session supports core public flows", {
  skip: skipReason("codex"),
  timeout: e2eTimeoutMs + 30_000,
}, async () => {
  const project = makeProject("codex");
  let session: CodexSession | undefined;
  let resumed: CodexSession | undefined;
  const hooksSeen: string[] = [];
  const hooks: CodexHookHandlers = {
    SessionStart: (event) => {
      hooksSeen.push(event.hook_event_name);
    },
    UserPromptSubmit: (event) => {
      hooksSeen.push(event.hook_event_name);
    },
    Stop: (event) => {
      hooksSeen.push(event.hook_event_name);
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
      hooks,
    });
    const observed = observeSession(session);
    await prepareInteractivePrompt(session, observed, "codex");
    await session.resize({ cols: 101, rows: 31 });
    assert.equal(session.terminal.size.cols, 101);
    assert.equal(session.terminal.size.rows, 31);
    assert.ok(session.elwoodSessionId);
    assert.equal(session.cwd, project.cwd);
    if (!turnsEnabled) {
      await session.teardown();
      assert.equal(session.status, "torn_down");
      assert.equal(pathRemoved(project.sessionDir(session.elwoodSessionId)), true);
      return;
    }
    await session.sendPrompt("Reply exactly: ELWOOD_E2E_CODEX_OK. Do not use tools.");
    await waitFor(() => hookNamed(observed.hooks, "UserPromptSubmit"), "Codex UserPromptSubmit");
    await waitFor(() => hookNamed(observed.hooks, "Stop"), "Codex Stop hook");
    await waitFor(() => (hasActivity(observed.activities) ? true : undefined), "Codex activity");
    await waitFor(
      () => (hooksSeen.includes("SessionStart") ? true : undefined),
      "Codex SessionStart hook",
    );
    await session.stop();
    assert.equal(session.status, "stopped");
    resumed = await resumeCodex({
      cwd: project.cwd,
      stateDir: project.stateDir,
      elwoodSessionId: session.elwoodSessionId,
      autotrust: true,
      hooks,
    });
    const resumedObserved = observeSession(resumed);
    await resumed.sendKeys("\u001b");
    await waitFor(
      () => (resumedObserved.terminal.join("").length > 0 ? true : undefined),
      "resumed Codex PTY data",
      45_000,
    );
    await resumed.teardown();
    assert.equal(resumed.status, "torn_down");
    assert.equal(pathRemoved(project.sessionDir(session.elwoodSessionId)), true);
  } finally {
    await cleanup(resumed);
    await cleanup(session);
  }
});
