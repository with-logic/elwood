/**
 * Real Claude and Codex TUI intervention coverage for state-aware guidance.
 * Implements C-API-37, C-E2E-02, and C-E2E-03.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { type ElwoodAgentSession, startClaude, startCodex } from "../../src/index.ts";
import { cleanup, makeProject, skipReason, turnsEnabled, waitFor } from "./helpers.ts";

const skipTurnsReason = turnsEnabled ? undefined : "ELWOOD_E2E_SKIP_TURNS=1 disables turn flows";

type GuidanceOutcome = {
  readonly elapsedMs: number;
  readonly status: string;
  readonly screen: string;
};

async function guidanceFlow(session: ElwoodAgentSession, marker: string): Promise<GuidanceOutcome> {
  await waitFor(() => (session.status === "ready" ? true : undefined), "initial ready", 60_000);
  await session.sendMessage(
    "Write a detailed 2,000-word essay about terminal history. Do not use tools.",
  );
  await waitFor(
    () => (/esc to interrupt/i.test(session.terminal.snapshot().text) ? true : undefined),
    "turn visibly running",
    60_000,
  );
  const started = Date.now();
  await session.sendGuidance(`Coordinator intervention: stop the essay. Marker: ${marker}`);
  return {
    elapsedMs: Date.now() - started,
    status: session.status,
    screen: session.terminal.snapshot().text,
  };
}

test("C-API-37 real Claude receives guidance during an active turn", {
  skip: skipReason("claude") ?? skipTurnsReason,
  timeout: 120_000,
}, async () => {
  const project = makeProject("claude");
  const session = await startClaude({
    cwd: project.cwd,
    stateDir: project.stateDir,
    permissionMode: "bypassPermissions",
    autotrust: true,
    hooks: {},
  });
  try {
    const outcome = await guidanceFlow(session, "ELWOOD_GUIDANCE_CLAUDE_NOW");
    assert.ok(outcome.elapsedMs < 5_000, "guidance does not wait for turn readiness");
    assert.equal(outcome.status, "running", "the original turn was still active");
    assert.match(outcome.screen, /ELWOOD_GUIDANCE_CLAUDE_NOW/, "live TUI received guidance");
  } finally {
    await cleanup(session);
  }
});

test("C-API-37 real Codex receives guidance during an active turn", {
  skip: skipReason("codex") ?? skipTurnsReason,
  timeout: 120_000,
}, async () => {
  const project = makeProject("codex");
  const session = await startCodex({
    cwd: project.cwd,
    stateDir: project.stateDir,
    sandbox: "read-only",
    approvalPolicy: "never",
    autotrust: true,
    hooks: {},
  });
  try {
    const outcome = await guidanceFlow(session, "ELWOOD_GUIDANCE_CODEX_NOW");
    assert.ok(outcome.elapsedMs < 5_000, "guidance does not wait for turn readiness");
    assert.equal(outcome.status, "running", "the original turn was still active");
    assert.match(outcome.screen, /ELWOOD_GUIDANCE_CODEX_NOW/, "live TUI received guidance");
  } finally {
    await cleanup(session);
  }
});
