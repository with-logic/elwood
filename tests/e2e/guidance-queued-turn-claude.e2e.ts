/**
 * Real Claude readiness across the turns that run queued guidance (PRD §6.5, C-HOOK-24).
 * Claude Code 2.1.332 queues guidance sent during a turn without tools and, at that turn's `Stop`,
 * runs it at once as a new turn with its own `Stop`. Guidance sent during that queued turn reuses
 * its prompt ID and runs as yet another turn. The session must become `ready` only after the last
 * of them stops. Guidance that a caller's handler blocks never runs, so its `Stop` marks readiness.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { cleanup, skipIf, skipReason, skipTurns, waitFor } from "./helpers.ts";
import { queuedTurnMarker, readyEvidenceSinceEssay, startEssay } from "./queued-turn-claude.ts";

const options = { skip: skipIf(skipReason("claude"), skipTurns), timeout: 240_000 };
/** C-HOOK-24's bound, stated independently of the implementation. */
const queuedTurnStartLimitMs = 2_000;

test(
  "C-HOOK-24 real Claude stays running through queued turns and guidance sent during them",
  options,
  async () => {
    const { session, seen } = await startEssay();
    try {
      await session.sendGuidance(
        "Coordinator note A: after the essay, write a 300-word poem about keyboards. Do not use tools.",
      );
      await waitFor(() => (seen.stops > 0 ? true : undefined), "the essay's Stop", 120_000);
      const queuedTurnStarted = () =>
        /"promptSource":\s*"queued"/.test(readFileSync(seen.transcript, "utf8"));
      await waitFor(
        () => (queuedTurnStarted() ? true : undefined),
        "the queued turn's record",
        10_000,
      );
      // Claude is writing the poem as the queued turn; this note queues behind it.
      await session.sendGuidance(
        `Coordinator note B: afterwards, reply with only the word ${queuedTurnMarker}.`,
      );
      await waitFor(
        () => (seen.replied ? true : undefined),
        "the last queued turn's reply",
        120_000,
      );
      await waitFor(() => (session.status === "ready" ? true : undefined), "ready", 30_000);
      assert.deepEqual(seen.guidanceAfterStops, [0, 1], "each note queued behind a running turn");
      assert.equal(seen.stops, 3, "the essay, the poem, and the reply each stop");
      assert.deepEqual(seen.readyAfterStops, [3], "ready only after the last queued turn's Stop");
      assert.deepEqual(seen.warnings, []);
    } finally {
      await cleanup(session);
    }
  },
);

test("C-HOOK-24 real Claude blocked guidance never runs and holds no Stop", options, async () => {
  const blocked = { decision: "block" as const, reason: "Blocked by policy." };
  const { session, seen } = await startEssay(() => blocked);
  try {
    await session.sendGuidance(`Coordinator note: reply with only the word ${queuedTurnMarker}.`);
    await waitFor(() => (seen.stops > 0 ? true : undefined), "the essay's Stop", 120_000);
    await waitFor(() => (session.status === "ready" ? true : undefined), "ready", 30_000);
    await new Promise((resolve) => setTimeout(resolve, queuedTurnStartLimitMs + 1_000));
    assert.deepEqual(seen.guidanceAfterStops, [0], "the note queued before the essay's Stop");
    assert.equal(seen.stops, 1);
    assert.deepEqual(seen.readyAfterStops, [1]);
    // The essay's own `Stop` marked readiness: no hold, so the screen's later end changed nothing.
    assert.deepEqual(readyEvidenceSinceEssay(session), ["hook_turn_ended"]);
    assert.deepEqual(seen.warnings, []);
  } finally {
    await cleanup(session);
  }
});
