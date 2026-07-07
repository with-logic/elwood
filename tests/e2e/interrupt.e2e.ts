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
  narrow = false,
): Promise<InterruptOutcome> {
  const statuses: string[] = [];
  session.on("status", (event) => statuses.push(event.status));
  await waitFor(() => (session.status === "ready" ? true : undefined), "initial ready", 60_000);
  await session.sendMessage(
    "Write a 400-word essay about the history of terminals. Think carefully. Do not use tools.",
  );
  // Wait until the turn is visibly mid-flight. Narrow screens elide the
  // footer token (C-TURN-04) and the tiny viewport caps text growth, so
  // there we wait for a stream of distinct rendered frames instead.
  let lastFrame = session.terminal.snapshot().text;
  let distinctFrames = 0;
  await waitFor(
    () => {
      if (!narrow) {
        return /esc to interrupt/i.test(session.terminal.snapshot().text) ? true : undefined;
      }
      const frame = session.terminal.snapshot().text;
      if (frame !== lastFrame) {
        lastFrame = frame;
        distinctFrames += 1;
      }
      return distinctFrames >= 6 ? true : undefined;
    },
    "turn visibly running",
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

for (const size of [
  { cols: 80, rows: 24, narrow: false },
  { cols: 46, rows: 12, narrow: true },
]) {
  test(`C-TURN-02 C-TURN-04 real Claude Esc interrupt emits ready at ${size.cols}x${size.rows}`, {
    skip: skipReason("claude") ?? skipTurnsReason,
    timeout: 240_000,
  }, async () => {
    const project = makeProject("claude");
    let stops = 0;
    const session = await startClaude({
      cwd: project.cwd,
      stateDir: project.stateDir,
      initialSize: { cols: size.cols, rows: size.rows },
      permissionMode: "bypassPermissions",
      autotrust: true,
      hooks: {
        Stop: () => {
          stops += 1;
        },
      },
    });
    try {
      const outcome = await interruptFlow(session, () => stops, size.narrow);
      assert.ok(outcome.sawRunning, "running status emitted for the turn");
      assert.equal(outcome.lastStatus, "ready", "ready status emitted on interrupt");
    } finally {
      await cleanup(session);
    }
  });
}

test("C-TURN-02 real Codex Esc interrupt emits ready and stays usable", {
  skip: skipReason("codex") ?? skipTurnsReason,
  timeout: 240_000,
}, async () => {
  const project = makeProject("codex");
  let stops = 0;
  const session = await startCodex({
    cwd: project.cwd,
    stateDir: project.stateDir,
    // Codex's working spinner survives even 46 columns (C-TURN-04 capture).
    initialSize: { cols: 46, rows: 12 },
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
