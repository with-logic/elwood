/**
 * Real Claude readiness when a caller's `UserPromptSubmit` handler is still screening queued
 * guidance at the running turn's `Stop` (PRD §6.5, C-HOOK-24). Claude Code 2.1.332 runs the
 * message only once the handler allows it, and never runs one it blocks.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { cleanup, skipIf, skipReason, skipTurns, waitFor } from "./helpers.ts";
import {
  queuedTurnMarker,
  queuedTurnRecorded,
  readyEvidenceSinceEssay,
  startEssay,
} from "./queued-turn-claude.ts";

const options = { skip: skipIf(skipReason("claude"), skipTurns), timeout: 240_000 };
/** Past C-HOOK-24's 2-second bound, stated independently of the implementation. */
const pastTheBoundMs = 3_500;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test(
  "C-HOOK-24 real Claude stays running while a handler screens guidance past Stop",
  options,
  async () => {
    const screened: number[] = [];
    const { session, seen } = await startEssay(async () => {
      await seen.firstStop;
      await sleep(pastTheBoundMs);
      screened.push(seen.stopCount);
      return undefined;
    });
    try {
      await session.sendGuidance(`Coordinator note: reply with only the word ${queuedTurnMarker}.`);
      await waitFor(() => (seen.replied ? true : undefined), "the queued turn's reply", 120_000);
      await waitFor(() => (session.status === "ready" ? true : undefined), "ready", 30_000);
      assert.deepEqual(
        { guidance: seen.guidanceAfterStops, screened, stops: seen.stopCount },
        { guidance: [0], screened: [1], stops: 2 },
        "the handler allowed the note after the essay's Stop, and Claude then ran it",
      );
      assert.deepEqual(seen.readyAfterStops, [2], "ready only after the queued turn's Stop");
      assert.deepEqual(seen.warningCodes, []);
    } finally {
      await cleanup(session);
    }
  },
);

test(
  "C-HOOK-24 real Claude guidance blocked after Stop ends the turn without a warning",
  options,
  async () => {
    const { session, seen } = await startEssay(async () => {
      await seen.firstStop;
      await sleep(500);
      return { decision: "block" as const, reason: "Blocked by policy." };
    });
    try {
      await session.sendGuidance(`Coordinator note: reply with only the word ${queuedTurnMarker}.`);
      await waitFor(() => (seen.stopCount > 0 ? true : undefined), "the essay's Stop", 120_000);
      await waitFor(() => (session.status === "ready" ? true : undefined), "ready", 30_000);
      await sleep(pastTheBoundMs);
      assert.deepEqual(
        { guidance: seen.guidanceAfterStops, stops: seen.stopCount, ready: seen.readyAfterStops },
        { guidance: [0], stops: 1, ready: [1] },
      );
      assert.deepEqual(readyEvidenceSinceEssay(session), ["hook_turn_ended"]);
      assert.deepEqual(seen.warningCodes, []);
      assert.equal(queuedTurnRecorded(seen), false, "Claude started no queued turn");
      assert.equal(seen.replied, false);
    } finally {
      await cleanup(session);
    }
  },
);
