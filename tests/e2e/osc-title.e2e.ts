/**
 * Real agents emit a braille-spinner OSC window title while a turn runs and a
 * non-spinner title when idle; Elwood exposes it on the terminal handle.
 * Implements C-TURN-05, C-E2E-02, and C-E2E-03.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { type ElwoodAgentSession, startClaude, startCodex } from "../../src/index.ts";
import { cleanup, makeProject, skipReason, turnsEnabled, waitFor } from "./helpers.ts";

const skipTurnsReason = turnsEnabled ? undefined : "ELWOOD_E2E_SKIP_TURNS=1 disables turn flows";
const brailleSpinner = /^[⠀-⣿]\s/;

async function titleFlow(
  session: ElwoodAgentSession,
): Promise<{ working: boolean; idle: boolean }> {
  await waitFor(() => (session.status === "ready" ? true : undefined), "initial ready", 60_000);
  await session.sendMessage("Count slowly from 1 to 20, one per line. Do not use tools.");
  // While the turn runs, the OSC title carries a braille spinner.
  const working = await waitFor(
    () => (brailleSpinner.test(session.terminal.title) ? true : undefined),
    "spinner title while working",
  );
  await waitFor(() => (session.status === "ready" ? true : undefined), "turn complete");
  // Once idle, the title is no longer a spinner.
  const idle = await waitFor(
    () => (brailleSpinner.test(session.terminal.title) ? undefined : true),
    "non-spinner title when idle",
  );
  return { working, idle };
}

test("C-TURN-05 real Claude emits a working spinner in the OSC title", {
  skip: skipReason("claude") ?? skipTurnsReason,
  timeout: 240_000,
}, async () => {
  const project = makeProject("claude");
  const session = await startClaude({
    cwd: project.cwd,
    stateDir: project.stateDir,
    permissionMode: "bypassPermissions",
    autotrust: true,
  });
  try {
    const outcome = await titleFlow(session);
    assert.ok(outcome.working, "spinner title observed while working");
    assert.ok(outcome.idle, "non-spinner title observed when idle");
  } finally {
    await cleanup(session);
  }
});

test("C-TURN-05 real Codex emits a working spinner in the OSC title", {
  skip: skipReason("codex") ?? skipTurnsReason,
  timeout: 240_000,
}, async () => {
  const project = makeProject("codex");
  const session = await startCodex({
    cwd: project.cwd,
    stateDir: project.stateDir,
    sandbox: "read-only",
    approvalPolicy: "never",
    autotrust: true,
  });
  try {
    const outcome = await titleFlow(session);
    assert.ok(outcome.working, "spinner title observed while working");
    assert.ok(outcome.idle, "non-spinner title observed when idle");
  } finally {
    await cleanup(session);
  }
});
