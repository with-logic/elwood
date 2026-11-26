/**
 * Real Claude readiness when Elwood cannot read the transcript during a held `Stop` (PRD §6.5,
 * C-HOOK-24). A failed read is not evidence that Claude left the queued guidance unrun, so the
 * `Stop` keeps holding until a read succeeds and shows the queued turn starting.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  readTranscriptBytes,
  resetByteReaderForTests,
  setByteReaderForTests,
  withTranscriptFile,
} from "../../src/core/transcript/cursor-io.ts";
import { cleanup, skipIf, skipReason, skipTurns, waitFor } from "./helpers.ts";
import { queuedTurnMarker, startEssay } from "./queued-turn-claude.ts";

const options = { skip: skipIf(skipReason("claude"), skipTurns), timeout: 240_000 };
/** Past C-HOOK-24's 2-second bound, stated independently of the implementation. */
const unreadableForMs = 4_000;

test(
  "C-HOOK-24 real Claude stays running while its transcript cannot be read past the bound",
  options,
  async () => {
    const { session, seen } = await startEssay();
    let unreadable = false;
    setByteReaderForTests((path, start, length) => {
      if (unreadable && path === seen.transcriptPath)
        throw Object.assign(new Error("Injected transcript read failure."), { code: "EIO" });
      return withTranscriptFile(path, (fd) => readTranscriptBytes(fd, start, length));
    });
    session.on("hook", (event) => {
      if (event.hook_event_name !== "Stop" || seen.stopCount !== 1) return;
      unreadable = true;
      setTimeout(() => {
        unreadable = false;
      }, unreadableForMs);
    });
    try {
      await session.sendGuidance(
        `Coordinator note: write three sentences about keyboards, then the word ${queuedTurnMarker}.`,
      );
      await waitFor(() => (seen.replied ? true : undefined), "the queued turn's reply", 120_000);
      await waitFor(() => (session.status === "ready" ? true : undefined), "ready", 30_000);
      assert.deepEqual(
        { guidance: seen.guidanceAfterStops, stops: seen.stopCount },
        { guidance: [0], stops: 2 },
        "the note was queued during the essay, and Claude ran it as a second turn",
      );
      assert.ok(seen.warningCodes.includes("transcript_read_error"), "the reads failed");
      assert.deepEqual(seen.readyAfterStops, [2], "ready only after the queued turn's Stop");
      assert.ok(!seen.warningCodes.includes("queued_turn_unconfirmed"));
    } finally {
      resetByteReaderForTests();
      await cleanup(session);
    }
  },
);
