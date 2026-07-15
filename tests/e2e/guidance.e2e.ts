/**
 * Real Claude and Codex TUI intervention coverage for state-aware guidance.
 * Implements C-API-37, C-E2E-02, and C-E2E-03.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ElwoodActivityEvent } from "../../src/core/activity.ts";
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
  // Whether the agent STRUCTURALLY consumed the guidance — a `user_message`
  // activity (projected from the adapter's real `UserPromptSubmit` hook) carrying
  // the marker. This fires only on an actual prompt submission, so it distinguishes
  // "the agent accepted the guidance" from "text is merely staged in the composer",
  // which would also make the marker appear on screen.
  readonly structurallyConsumed: boolean;
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
  // Record status transitions AND submission activities across the guidance send.
  // A `ready` transition would mean guidance waited for the turn to finish; a
  // `user_message` activity carrying the marker means the agent actually ingested
  // the guidance as a submitted prompt (not just staged it in the composer).
  const transitionsDuringGuidance: ElwoodSessionStatus[] = [];
  const submissions: ElwoodActivityEvent[] = [];
  const offStatus = session.on("status", (event) => transitionsDuringGuidance.push(event.status));
  const offActivity = session.on("activity", (event) => {
    if (event.kind === "user_message") submissions.push(event);
  });
  try {
    await session.sendGuidance(`Coordinator intervention: stop the essay. Marker: ${marker}`);
    // Wait for the structural consumption signal: the adapter's UserPromptSubmit
    // hook fires asynchronously after the paste + Enter is actually ingested.
    await waitFor(
      () => (submissions.some((e) => e.text?.includes(marker)) ? true : undefined),
      "guidance structurally consumed (UserPromptSubmit)",
      30_000,
    );
  } finally {
    offStatus();
    offActivity();
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
  return {
    transitionsDuringGuidance,
    status,
    screen,
    structurallyConsumed: submissions.some((e) => e.text?.includes(marker)),
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
    assert.ok(
      !outcome.transitionsDuringGuidance.includes("ready"),
      "guidance settled into the live running turn without waiting for a ready transition",
    );
    assert.equal(outcome.status, "running", "the original turn was still active");
    assert.ok(
      outcome.structurallyConsumed,
      "Claude structurally consumed the guidance (UserPromptSubmit), not merely staged it",
    );
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
    assert.ok(
      outcome.structurallyConsumed,
      "Codex structurally consumed the guidance (UserPromptSubmit), not merely staged it",
    );
    assert.match(outcome.screen, /ELWOOD_GUIDANCE_CODEX_NOW/, "live TUI received guidance");
  } finally {
    await cleanup(session);
  }
});
