/**
 * Real Claude and Codex TUI intervention coverage for state-aware guidance.
 * Implements C-API-37, C-E2E-02, and C-E2E-03.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  type ElwoodAgentSession,
  type ElwoodSessionStatus,
  startClaude,
  startCodex,
} from "../../src/index.ts";
import { cleanup, makeProject, skipReason, turnsEnabled, waitFor } from "./helpers.ts";

const skipTurnsReason = turnsEnabled ? undefined : "ELWOOD_E2E_SKIP_TURNS=1 disables turn flows";

type GuidanceOutcome = {
  // Status transitions observed from the moment guidance was sent until it
  // settled. A guidance that BYPASSED readiness settles into the live running
  // turn without an intervening `ready` transition; one that waited for the turn
  // to finish would show a `ready` transition first.
  readonly transitionsDuringGuidance: readonly ElwoodSessionStatus[];
  readonly status: ElwoodSessionStatus;
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
  // Record status transitions across the guidance send. If guidance waited for
  // the turn to reach `ready` before delivering, a `ready` transition would land
  // here; a guidance that entered the live running turn shows none.
  const transitionsDuringGuidance: ElwoodSessionStatus[] = [];
  const off = session.on("status", (event) => transitionsDuringGuidance.push(event.status));
  try {
    await session.sendGuidance(`Coordinator intervention: stop the essay. Marker: ${marker}`);
  } finally {
    off();
  }
  const status = session.status;
  // The TUI may not have redrawn the marker yet, so poll for it before snapshotting.
  const screen = await waitFor(
    () => {
      const text = session.terminal.snapshot().text;
      return text.includes(marker) ? text : undefined;
    },
    "guidance marker on screen",
    30_000,
  );
  return { transitionsDuringGuidance, status, screen };
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
    assert.ok(
      !outcome.transitionsDuringGuidance.includes("ready"),
      "guidance settled into the live running turn without waiting for a ready transition",
    );
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
    assert.ok(
      !outcome.transitionsDuringGuidance.includes("ready"),
      "guidance settled into the live running turn without waiting for a ready transition",
    );
    assert.equal(outcome.status, "running", "the original turn was still active");
    assert.match(outcome.screen, /ELWOOD_GUIDANCE_CODEX_NOW/, "live TUI received guidance");
  } finally {
    await cleanup(session);
  }
});
