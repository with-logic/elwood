/**
 * Poll/finish race coverage for the Claude transcript watcher (PRD §5.4, C-CLAUDE-15):
 * a drop orphaned in the pass's pending when finish() latches terminal:exit must be
 * discarded by the resuming poll (never flushed past the latch), and a timer-path
 * listener error surfaces as a bounded transcript_poll_stopped warning.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  createTranscriptWatcher,
  type TranscriptActivityEmitter,
  type WarningSink,
} from "../../src/claude/session-transcript.ts";
import type { ElwoodActivityEvent } from "../../src/core/activity.ts";
import type { ElwoodWarningEvent } from "../../src/core/types.ts";

function fakeEmitter(
  sink: (event: ElwoodActivityEvent) => void = () => {},
): TranscriptActivityEmitter {
  return { emit: (_event, payload) => sink(payload) };
}

const assistant = (text: string) => ({
  type: "assistant",
  message: { content: [{ type: "text", text }] },
});

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "elwood-tx-")), "t.jsonl");
}

describe("C-CLAUDE-15 transcript poll/finish race", () => {
  test("§5.4 a drop orphaned by a throwing finish-drain is DISCARDED by the resumed poll, not flushed past exit", async () => {
    // The FULL compound race, made deterministic via the after-scan seam:
    //   1. A poll pass is in flight (cursor A scanned, no drop yet).
    //   2. The seam fires finish() before the loop advances to cursor B.
    //   3. finish()'s terminal drain records a drop for B (a malformed trailing record)
    //      AND emits B's clean line through an activity listener that THROWS — the throw
    //      escapes drainToBudget BEFORE its own flushPass(), so the drop stays PENDING.
    //   4. The PTY-exit boundary (here the seam's try/catch) contains the throw, and
    //      finish() still latches terminal:exit.
    //   5. The poll resumes, bails on `finished`, and its finally must DISCARD the orphaned
    //      pending drop. The pre-fix unconditional flush would emit it here, after exit.
    const recorded: ElwoodWarningEvent[] = [];
    const sink: WarningSink = { emitWarnings: (w) => recorded.push(...w) };
    // The activity listener throws ONLY on B's assistant line (not A's, which the poll
    // scans first — a throw there would break the poll before the race even sets up).
    const emitter = fakeEmitter((ev) => {
      if (ev.kind === "assistant_message" && ev.text?.includes("boom-b")) {
        throw new Error("listener boom");
      }
    });
    const { watcher } = createTranscriptWatcher("s9", emitter, () => sink);
    const a = tmpFile();
    const b = tmpFile();
    writeFileSync(a, "");
    writeFileSync(b, "");
    watcher.observe(a);
    watcher.observe(b);
    writeFileSync(a, `${JSON.stringify(assistant("a"))}\n`); // A: clean, scanned first
    // B stays at EOF for the poll; finish()'s drain sees its new content: a MALFORMED
    // record (records a drop into pending) THEN a clean line whose activity listener
    // THROWS — the throw escapes drainToBudget before its own flushPass(), orphaning B's
    // drop in pending. The seam contains the throw as the real PTY-exit boundary would.
    watcher.setAfterScanForTests(() => {
      writeFileSync(b, `{ bad-b }\n${JSON.stringify(assistant("boom-b"))}\n`);
      try {
        watcher.finish();
      } catch {
        // The PTY-exit boundary contains this throw; terminal:exit is still latched.
      }
    });
    await watcher.pollOnceForTests();
    // The orphaned drop must NOT surface after terminal:exit.
    expect(recorded.some((w) => w.code === "transcript_records_dropped")).toBe(false);
  });

  test("a timer-path listener error is routed to the sink as a transcript_poll_stopped warning", async () => {
    const recorded: ElwoodWarningEvent[] = [];
    const sink: WarningSink = { emitWarnings: (w) => recorded.push(...w) };
    // The transcript event emitter throws — a programming error on the timer path.
    const emitter = fakeEmitter((a) => {
      if (a.kind === "assistant_message") throw new Error("listener bug");
    });
    // A short poll cadence via the seam + waitFor makes the timer-path assertion
    // deterministic, not a fixed sleep race (the pattern used in the recovery tests).
    const { watcher } = createTranscriptWatcher("s9", emitter, () => sink, 5);
    const path = tmpFile();
    try {
      writeFileSync(path, "");
      watcher.observe(path);
      writeFileSync(path, `${JSON.stringify(assistant("boom"))}\n`);
      await vi.waitFor(() =>
        expect(recorded.some((w) => w.code === "transcript_poll_stopped")).toBe(true),
      );
    } finally {
      watcher.finish(); // always stop the watcher, even if the assertion throws
    }
  });
});
