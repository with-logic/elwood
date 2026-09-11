/**
 * Coverage for finishSafely: the final-flush error boundary at PTY exit.
 * Covers PRD §5.3/§5.4 (C-CLAUDE-15, C-LIFE-10): a throwing activity listener or a
 * throwing warning sink during the final transcript flush is contained so the
 * PTY-exit callback can still emit terminal:exit, transition to terminal status, and reap.
 */

import { writeFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { createTranscriptWatcher, type WarningSink } from "../../src/claude/session/transcript.ts";
import type { ElwoodWarningEvent } from "../../src/core/types.ts";
import { assistant, fakeEmitter, tmpFile } from "./claude-transcript-helpers.ts";

describe("C-CLAUDE-15 / C-LIFE-10 finishSafely error boundary", () => {
  test("contains a throwing final flush and routes a bounded diagnostic", () => {
    // The final flush emits committed deltas through the activity listener. When
    // that listener throws, finishSafely must NOT propagate the throw (which would
    // abort the PTY-exit callback before terminal:exit/reap); it stops the watcher
    // and surfaces a bounded, content-free transcript_poll_stopped.
    const recorded: ElwoodWarningEvent[] = [];
    const sink: WarningSink = { emitWarnings: (w) => recorded.push(...w) };
    const emitter = fakeEmitter((a) => {
      if (a.kind === "assistant_message") throw new Error("flush listener bug");
    });
    const { watcher, finishSafely } = createTranscriptWatcher("s9", emitter, () => sink);
    const path = tmpFile();
    writeFileSync(path, "");
    watcher.observe(path); // baseline at EOF
    writeFileSync(path, `${JSON.stringify(assistant("committed"))}\n`); // unread until flush
    expect(() => finishSafely()).not.toThrow();
    // A failed FINAL flush is phase-labelled so an operator can tell lost
    // trailing shutdown activity from a live-watcher poll failure.
    const stopped = recorded.find((w) => w.code === "transcript_poll_stopped");
    expect(stopped).toBeDefined();
    if (stopped?.code === "transcript_poll_stopped") expect(stopped.phase).toBe("final_flush");
  });

  test("runs afterFlush in a finally even when the flush throws", () => {
    // afterFlush carries the terminal:exit/status/reap work; it MUST run whether or
    // not the flush threw, so termination always completes (C-LIFE-10).
    const sink: WarningSink = { emitWarnings: () => {} };
    const emitter = fakeEmitter((a) => {
      if (a.kind === "assistant_message") throw new Error("flush listener bug");
    });
    const { watcher, finishSafely } = createTranscriptWatcher("s9", emitter, () => sink);
    const path = tmpFile();
    writeFileSync(path, "");
    watcher.observe(path);
    writeFileSync(path, `${JSON.stringify(assistant("committed"))}\n`);
    let afterFlushRan = false;
    finishSafely(() => {
      afterFlushRan = true;
    });
    expect(afterFlushRan).toBe(true);
  });

  test("swallows a throwing diagnostic route so lifecycle never blocks", () => {
    // Both the flush listener AND the warning sink throw. finishSafely must contain
    // the routing throw too, so a diagnostic-listener bug can never block the
    // PTY-exit callback from completing termination.
    const sink: WarningSink = {
      emitWarnings: () => {
        throw new Error("sink bug");
      },
    };
    const emitter = fakeEmitter((a) => {
      if (a.kind === "assistant_message") throw new Error("flush listener bug");
    });
    const { watcher, finishSafely } = createTranscriptWatcher("s9", emitter, () => sink);
    const path = tmpFile();
    writeFileSync(path, "");
    watcher.observe(path);
    writeFileSync(path, `${JSON.stringify(assistant("committed"))}\n`);
    let afterFlushRan = false;
    expect(() => finishSafely(() => (afterFlushRan = true))).not.toThrow();
    expect(afterFlushRan).toBe(true); // afterFlush still ran despite both throws
  });
});
