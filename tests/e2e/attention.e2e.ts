/**
 * Real-agent permission dialogs drive the session to `blocked` and emit an
 * `attention` activity from rendered screen state alone.
 * Implements C-ATTN-01, C-ATTN-02, C-E2E-02, and C-E2E-03.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ElwoodActivityEvent } from "../../src/core/activity/index.ts";
import { type ElwoodAgentSession, startClaude, startCodex } from "../../src/index.ts";
import { cleanup, makeProject, skipIf, skipReason, skipTurns, waitFor } from "./helpers.ts";

async function attentionFlow(session: ElwoodAgentSession): Promise<readonly ElwoodActivityEvent[]> {
  const attention: ElwoodActivityEvent[] = [];
  session.on("activity", (event) => {
    if (event.kind === "attention") attention.push(event);
  });
  await waitFor(() => (session.status === "ready" ? true : undefined), "initial ready", 60_000);
  // A write to disk requires a permission/approval decision under the default
  // policy, so the agent renders a blocking dialog instead of proceeding.
  await session.sendMessage(
    "Create a file named elwood.txt containing the word hello. Use your file-writing tool.",
  );
  await waitFor(() => (session.status === "blocked" ? true : undefined), "blocked on approval");
  // Decline through the dialog with a raw Escape byte (the string overload
  // would be reinterpreted by the xterm input pipeline) so the session
  // leaves the blocked state.
  await session.sendKeys(new Uint8Array([0x1b]));
  await waitFor(() => (session.status === "ready" ? true : undefined), "recovered after declining");
  return attention;
}

test("C-ATTN-01 real Claude permission dialog blocks and emits attention", {
  skip: skipIf(skipReason("claude"), skipTurns),
  timeout: 240_000,
}, async () => {
  const project = makeProject("claude");
  const session = await startClaude({
    cwd: project.cwd,
    stateDir: project.stateDir,
    permissionMode: "default",
    autotrust: true,
  });
  try {
    const attention = await attentionFlow(session);
    assert.ok(attention.length > 0, "attention activity emitted while blocked");
    // C-ATTN-01: the label names the matched screen-fact rule id.
    assert.ok(
      attention.some((event) => event.label.includes("claude-permission-dialog")),
      "attention labels the claude-permission-dialog rule",
    );
  } finally {
    await cleanup(session);
  }
});

test("C-ATTN-01 real Codex approval dialog blocks and emits attention", {
  skip: skipIf(skipReason("codex"), skipTurns),
  timeout: 240_000,
}, async () => {
  const project = makeProject("codex");
  const session = await startCodex({
    cwd: project.cwd,
    stateDir: project.stateDir,
    approvalPolicy: "untrusted",
    autotrust: true,
  });
  try {
    const attention = await attentionFlow(session);
    assert.ok(attention.length > 0, "attention activity emitted while blocked");
    assert.ok(
      attention.some((event) => event.label.includes("codex-approval-dialog")),
      "attention labels the codex-approval-dialog rule",
    );
  } finally {
    await cleanup(session);
  }
});
