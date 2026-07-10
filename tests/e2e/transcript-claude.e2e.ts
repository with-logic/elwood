/**
 * Real Claude assistant_message provenance: committed transcript, not the hook.
 * Implements C-E2E-07 for C-CLAUDE-15.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ElwoodActivityEvent } from "../../src/core/activity.ts";
import { type ClaudeSession, startClaude } from "../../src/index.ts";
import {
  cleanup,
  e2eTimeoutMs,
  makeProject,
  observeSession,
  skipReason,
  turnsEnabled,
  waitFor,
} from "./helpers.ts";

const skipTurnsReason = turnsEnabled ? undefined : "ELWOOD_E2E_SKIP_TURNS=1 disables turn flows";

test("C-E2E-07 real Claude assistant_message comes from the committed transcript", {
  skip: skipReason("claude") ?? skipTurnsReason,
  timeout: e2eTimeoutMs + 30_000,
}, async () => {
  const project = makeProject("claude");
  let session: ClaudeSession | undefined;
  try {
    session = await startClaude({
      cwd: project.cwd,
      stateDir: project.stateDir,
      initialSize: { cols: 100, rows: 30 },
      permissionMode: "bypassPermissions",
      hookTimeoutMs: 10_000,
      autotrust: true,
    });
    const observed = observeSession(session);
    const acts = () => observed.activities as readonly ElwoodActivityEvent[];
    await session.sendMessage("Reply briefly, then stop. Do not use tools.");

    // Any committed assistant turn must surface as an assistant_message whose
    // provenance is the transcript (source: "transcript"), NOT the Stop hook.
    // Asserting on structure — not exact model text — avoids flaking on wording.
    await waitFor(
      () => (transcriptAssistant(acts()) ? true : undefined),
      "transcript-sourced Claude assistant_message",
    );
    const message = transcriptAssistant(acts());
    assert.ok(message, "assistant_message present");
    assert.equal(message.source, "transcript");
    assert.ok(message.transcriptPath && message.transcriptPath.length > 0);
    assert.ok((message.text ?? "").length > 0, "committed assistant text is non-empty");

    // No assistant_message may originate from the hook path: that path can
    // carry un-sent ghost-text, which C-CLAUDE-15 forbids emitting as a message.
    const fromHook = acts().filter(
      (a) => a.agent === "claude" && a.kind === "assistant_message" && a.source === "hook",
    );
    assert.equal(fromHook.length, 0, "no assistant_message sourced from the hook");

    await session.kill();
    observed.dispose();
  } finally {
    await cleanup(session);
  }
});

test("C-E2E-08 real Claude tool_call/tool_result come from the committed transcript", {
  skip: skipReason("claude") ?? skipTurnsReason,
  timeout: e2eTimeoutMs + 30_000,
}, async () => {
  const project = makeProject("claude");
  let session: ClaudeSession | undefined;
  try {
    session = await startClaude({
      cwd: project.cwd,
      stateDir: project.stateDir,
      initialSize: { cols: 100, rows: 30 },
      permissionMode: "bypassPermissions",
      hookTimeoutMs: 10_000,
      autotrust: true,
    });
    const observed = observeSession(session);
    const acts = () => observed.activities as readonly ElwoodActivityEvent[];
    // A deterministic, cheap tool turn: read the AGENTS.md the fixture writes.
    await session.sendMessage("Use your Read tool to read AGENTS.md, then stop.");

    await waitFor(
      () =>
        transcriptTool(acts(), "tool_call") && transcriptTool(acts(), "tool_result")
          ? true
          : undefined,
      "transcript-sourced Claude tool_call and tool_result",
    );
    const call = transcriptTool(acts(), "tool_call");
    const result = transcriptTool(acts(), "tool_result");
    assert.ok(call && result, "committed tool_call and tool_result present");
    // Correlated ids and serialized io, all from the transcript boundary.
    assert.ok(call.toolUseId && call.toolUseId.length > 0, "tool_call has a tool_use id");
    assert.ok((call.toolInput ?? "").length > 0, "tool_call carries serialized input");
    assert.ok((result.toolOutput ?? "").length > 0, "tool_result carries serialized output");
    assert.equal(result.toolUseId, call.toolUseId, "result correlates to the call id");

    // Claude tool hooks must NOT also emit tool activity (C-CLAUDE-15 / M2).
    const hookTools = acts().filter(
      (a) =>
        a.agent === "claude" &&
        (a.kind === "tool_call" || a.kind === "tool_result") &&
        a.source === "hook",
    );
    assert.equal(hookTools.length, 0, "no hook-sourced Claude tool activity");

    await session.kill();
    observed.dispose();
  } finally {
    await cleanup(session);
  }
});

function transcriptAssistant(
  activities: readonly ElwoodActivityEvent[],
): ElwoodActivityEvent | undefined {
  return activities.find(
    (a) =>
      a.agent === "claude" &&
      a.kind === "assistant_message" &&
      a.source === "transcript" &&
      (a.text ?? "").length > 0,
  );
}

function transcriptTool(
  activities: readonly ElwoodActivityEvent[],
  kind: "tool_call" | "tool_result",
): ElwoodActivityEvent | undefined {
  return activities.find(
    (a) => a.agent === "claude" && a.kind === kind && a.source === "transcript",
  );
}
