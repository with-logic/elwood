/**
 * Real-agent Escape interrupts produce turn-end signals and live readiness.
 * Implements C-TURN-01, C-TURN-02, C-E2E-02, and C-E2E-03.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { type ElwoodAgentSession, startClaude, startCodex } from "../../src/index.ts";
import { cleanup, makeProject, skipReason, turnsEnabled, waitFor } from "./helpers.ts";

const skipTurnsReason = turnsEnabled ? undefined : "ELWOOD_E2E_SKIP_TURNS=1 disables turn flows";

type InterruptOutcome = { readonly sawRunning: boolean; readonly lastStatus: string | undefined };

async function interruptFlow(
  session: ElwoodAgentSession,
  stops: () => number,
): Promise<InterruptOutcome> {
  const statuses: string[] = [];
  session.on("status", (event) => statuses.push(event.status));
  await waitFor(() => (session.status === "ready" ? true : undefined), "initial ready", 60_000);
  await session.sendMessage(
    "Write a 400-word essay about the history of terminals. Think carefully. Do not use tools.",
  );
  // Wait until the rendered TUI shows the turn actually running.
  await waitFor(
    () => (/esc to interrupt/i.test(session.terminal.snapshot().text) ? true : undefined),
    "working indicator",
    60_000,
  );
  await session.sendKeys("");
  // C-TURN-02: ready returns regardless of whether a Stop hook fires — on a
  // mid-generation Esc none fires (that path is pinned deterministically in
  // the unit tests); near a block boundary the CLI may emit one.
  await waitFor(() => (session.status === "ready" ? true : undefined), "ready after interrupt");
  const outcome = { sawRunning: statuses.includes("running"), lastStatus: statuses.at(-1) };
  // C-TURN-01: readiness is real — the queued follow-up submits and completes.
  // (This exact flow deadlocked forever before turn-state watching.)
  const stopsBefore = stops();
  await session.sendMessage("Reply exactly: ELWOOD_INTERRUPT_OK. Do not use tools.");
  await waitFor(() => (stops() > stopsBefore ? true : undefined), "follow-up turn Stop hook");
  return outcome;
}

test("C-TURN-02 real Claude Esc interrupt emits ready and stays usable", {
  skip: skipReason("claude") ?? skipTurnsReason,
  timeout: 240_000,
}, async () => {
  const project = makeProject("claude");
  let stops = 0;
  const session = await startClaude({
    cwd: project.cwd,
    stateDir: project.stateDir,
    permissionMode: "bypassPermissions",
    autotrust: true,
    hooks: {
      Stop: () => {
        stops += 1;
      },
    },
  });
  try {
    const outcome = await interruptFlow(session, () => stops);
    assert.ok(outcome.sawRunning, "running status emitted for the turn");
    assert.equal(outcome.lastStatus, "ready", "ready status emitted on interrupt");
  } finally {
    await cleanup(session);
  }
});

test("C-TURN-02 real Codex Esc interrupt emits ready and stays usable", {
  skip: skipReason("codex") ?? skipTurnsReason,
  timeout: 240_000,
}, async () => {
  const project = makeProject("codex");
  let stops = 0;
  const session = await startCodex({
    cwd: project.cwd,
    stateDir: project.stateDir,
    sandbox: "read-only",
    approvalPolicy: "never",
    autotrust: true,
    hooks: {
      Stop: () => {
        stops += 1;
      },
    },
  });
  try {
    const outcome = await interruptFlow(session, () => stops);
    assert.ok(outcome.sawRunning, "running status emitted for the turn");
    assert.equal(outcome.lastStatus, "ready", "ready status emitted on interrupt");
  } finally {
    await cleanup(session);
  }
});
