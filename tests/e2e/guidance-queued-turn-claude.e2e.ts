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
import { queuedTurnStartLimitMs } from "../../src/claude/session/queued-turn.ts";
import { startClaude } from "../../src/index.ts";
import {
  cleanup,
  makeProject,
  skipIf,
  skipReason,
  skipTurns,
  waitFor,
  waitForVisibleTurn,
} from "./helpers.ts";

const marker = "ELWOOD_QUEUED_TURN";
const options = { skip: skipIf(skipReason("claude"), skipTurns), timeout: 240_000 };

async function startEssay(blockGuidance = false) {
  const project = makeProject("claude");
  const session = await startClaude({
    cwd: project.cwd,
    stateDir: project.stateDir,
    permissionMode: "bypassPermissions",
    autotrust: true,
    hooks: {
      UserPromptSubmit: (event) =>
        blockGuidance && event.prompt.includes("Coordinator")
          ? { decision: "block" as const, reason: "Blocked by policy." }
          : undefined,
    },
  });
  const seen = {
    stops: 0,
    transcript: "",
    replied: false,
    warnings: [] as string[],
    readyAfterStops: [] as number[],
  };
  session.on("hook", (event) => {
    if (event.hook_event_name !== "Stop") return;
    seen.stops += 1;
    seen.transcript = event.transcript_path ?? seen.transcript;
  });
  session.on("activity", (event) => {
    if (event.kind === "assistant_message" && event.text?.includes(marker)) seen.replied = true;
  });
  session.on("warning", (warning) => void seen.warnings.push(warning.code));
  await waitFor(() => (session.status === "ready" ? true : undefined), "initial ready", 60_000);
  session.on("status", (event) => {
    if (event.status === "ready") seen.readyAfterStops.push(seen.stops);
  });
  await session.sendMessage(
    "Write a detailed 400-word essay about the history of terminals. Do not use tools.",
  );
  await waitForVisibleTurn(session);
  return { session, seen };
}

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
        `Coordinator note B: afterwards, reply with only the word ${marker}.`,
      );
      await waitFor(
        () => (seen.replied ? true : undefined),
        "the last queued turn's reply",
        120_000,
      );
      await waitFor(() => (session.status === "ready" ? true : undefined), "ready", 30_000);
      assert.equal(seen.stops, 3, "the essay, the poem, and the reply each stop");
      assert.deepEqual(seen.readyAfterStops, [3], "ready only after the last queued turn's Stop");
      assert.deepEqual(seen.warnings, []);
    } finally {
      await cleanup(session);
    }
  },
);

test("C-HOOK-24 real Claude blocked guidance never runs and holds no Stop", options, async () => {
  const { session, seen } = await startEssay(true);
  try {
    await session.sendGuidance(`Coordinator note: reply with only the word ${marker}.`);
    await waitFor(() => (seen.stops > 0 ? true : undefined), "the essay's Stop", 120_000);
    await waitFor(() => (session.status === "ready" ? true : undefined), "ready", 30_000);
    await new Promise((resolve) => setTimeout(resolve, queuedTurnStartLimitMs + 1_000));
    assert.equal(seen.stops, 1);
    assert.deepEqual(seen.readyAfterStops, [1]);
    // The essay's own `Stop` marked readiness: no hold, so the screen's later end changed nothing.
    const decisions = session.statusDecisions();
    const essay = decisions.findLastIndex((decision) => decision.evidence === "caller_submitted");
    const ends = decisions
      .slice(essay)
      .filter((decision) => decision.evidence.endsWith("_ended") && decision.to === "ready");
    assert.deepEqual(
      ends.map((decision) => decision.evidence),
      ["hook_turn_ended"],
    );
    assert.deepEqual(seen.warnings, []);
  } finally {
    await cleanup(session);
  }
});
