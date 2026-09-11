/**
 * Real-agent compact() and model launch option flows.
 * Implements C-API-22, C-CLAUDE-12, C-E2E-02, and C-E2E-03.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  type ClaudeSessionApi,
  type CodexSessionApi,
  startClaude,
  startCodex,
} from "../../src/index.ts";
import {
  cleanup,
  e2eTimeoutMs,
  makeProject,
  skipIf,
  skipReason,
  skipTurns,
  waitFor,
} from "./helpers.ts";

test("C-CLAUDE-12 C-API-22 real Claude starts on the requested model and compacts", {
  skip: skipIf(skipReason("claude"), skipTurns),
  timeout: e2eTimeoutMs + 30_000,
}, async () => {
  const project = makeProject("claude");
  let session: ClaudeSessionApi | undefined;
  let sessionStartModel: string | undefined;
  const compactHooks: string[] = [];
  let stops = 0;
  try {
    session = await startClaude({
      cwd: project.cwd,
      stateDir: project.stateDir,
      model: "haiku",
      permissionMode: "bypassPermissions",
      hookTimeoutMs: 10_000,
      autotrust: true,
      hooks: {
        SessionStart: (event) => {
          sessionStartModel = event.model;
        },
        PreCompact: (event) => {
          compactHooks.push(event.hook_event_name);
        },
        PostCompact: (event) => {
          compactHooks.push(event.hook_event_name);
        },
        Stop: () => {
          stops += 1;
        },
      },
    });
    // Two substantial turns: Claude refuses /compact on tiny conversations.
    await session.sendMessage(
      "Write a 300-word summary of how terminals, PTYs, and shells interact. Do not use tools.",
    );
    await waitFor(() => (stops >= 1 ? true : undefined), "first Claude Stop");
    assert.ok(sessionStartModel, "SessionStart reported a model");
    assert.match(sessionStartModel ?? "", /haiku/i, "launch model reached the real CLI");
    await session.sendMessage(
      "Now write 300 words on terminal escape sequences. Do not use tools.",
    );
    await waitFor(() => (stops >= 2 ? true : undefined), "second Claude Stop");
    await session.compact({ timeoutMs: e2eTimeoutMs });
    assert.ok(compactHooks.includes("PreCompact"), "PreCompact hook observed and validated");
    assert.ok(compactHooks.includes("PostCompact"), "PostCompact hook observed");
  } finally {
    await cleanup(session);
  }
});

test("C-API-22 real Codex compacts through the readiness queue", {
  skip: skipIf(skipReason("codex"), skipTurns),
  timeout: e2eTimeoutMs + 30_000,
}, async () => {
  const project = makeProject("codex");
  let session: CodexSessionApi | undefined;
  const compactHooks: string[] = [];
  let stops = 0;
  try {
    session = await startCodex({
      cwd: project.cwd,
      stateDir: project.stateDir,
      sandbox: "read-only",
      approvalPolicy: "never",
      hookTimeoutMs: 10_000,
      autotrust: true,
      hooks: {
        PreCompact: (event) => {
          compactHooks.push(event.hook_event_name);
        },
        PostCompact: (event) => {
          compactHooks.push(event.hook_event_name);
        },
        Stop: () => {
          stops += 1;
        },
      },
    });
    await session.sendMessage(
      "Write a 300-word summary of how terminals, PTYs, and shells interact. Do not use tools.",
    );
    await waitFor(() => (stops >= 1 ? true : undefined), "first Codex Stop");
    await session.sendMessage(
      "Now write 300 words on terminal escape sequences. Do not use tools.",
    );
    await waitFor(() => (stops >= 2 ? true : undefined), "second Codex Stop");
    await session.compact({ timeoutMs: e2eTimeoutMs });
    assert.ok(compactHooks.includes("PostCompact"), "PostCompact hook observed");
  } finally {
    await cleanup(session);
  }
});
