/**
 * Coverage for wiring the Claude transcript watcher into the session stream.
 * Covers PRD §5.4 (C-CLAUDE-15): both transcript paths observed; drops surfaced.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

/** A typed activity-emitter fake that records the events it receives. */
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

describe("C-CLAUDE-15 transcript session wiring", () => {
  test("a LONE drop buffered before the sink exists is flushed by flushPendingWarnings", () => {
    const activities: ElwoodActivityEvent[] = [];
    const emitter = fakeEmitter((a) => activities.push(a));
    const recorded: ElwoodWarningEvent[] = [];
    let sink: WarningSink | undefined; // not ready yet (early startup)
    const { watcher, flushPendingWarnings } = createTranscriptWatcher("s9", emitter, () => sink);
    const path = tmpFile();
    writeFileSync(path, "");
    watcher.observe(path);
    writeFileSync(path, `${JSON.stringify(assistant("wired"))}\n{ bad }\n`);
    watcher.scan();
    // Sink absent: the drop is NOT emitted as an activity-only warning (which
    // would neither persist nor replay) — it is held.
    expect(activities).not.toContainEqual(expect.objectContaining({ kind: "warning" }));
    expect(recorded).toEqual([]);
    // The session sink now exists. A SINGLE early warning must flush WITHOUT
    // needing a second diagnostic to trigger it (the lone-warning gap).
    sink = { emitWarnings: (w) => recorded.push(...w) };
    flushPendingWarnings();
    expect(recorded.some((w) => w.code === "transcript_records_dropped")).toBe(true);
  });

  test("§5.4 a pre-sink notice is delivered once; if delivery throws it is dropped, not retried", () => {
    const emitter = fakeEmitter(() => undefined);
    const recorded: ElwoodWarningEvent[] = [];
    let failNext = true;
    let sink: WarningSink | undefined; // buffer the notice before the sink exists
    const { watcher, flushPendingWarnings } = createTranscriptWatcher("s9", emitter, () => sink);
    const path = tmpFile();
    writeFileSync(path, "");
    watcher.observe(path);
    writeFileSync(path, "{ bad }\n");
    watcher.scan(); // buffered: no sink yet
    sink = {
      emitWarnings: (w) => {
        if (!failNext) return void recorded.push(...w);
        failNext = false;
        throw new Error("listener boom");
      },
    };
    // flushPendingWarnings clears the batch first, delivers once, then throws out of
    // the listener; the notice is dropped (live-only, not retained for retry).
    expect(() => flushPendingWarnings()).toThrow(/listener boom/);
    expect(recorded).toEqual([]);
    flushPendingWarnings(); // nothing queued — the earlier notice was dropped
    expect(recorded).toEqual([]);
  });

  test("§5.4 an ACTIVE sink that throws on a scan is contained; the warning is dropped, not retried", () => {
    // The sink already exists during steady-state polling. A scan produces a drop
    // whose listener throws: the throw must be CONTAINED (scan does not throw) so
    // observation continues, and the warning is DROPPED — live-only, a human's
    // terminal does not re-show a banner, so it is never re-delivered on a later scan.
    const emitter = fakeEmitter(() => undefined);
    const recorded: ElwoodWarningEvent[] = [];
    let failNext = true;
    const sink: WarningSink = {
      emitWarnings: (w) => {
        if (!failNext) return void recorded.push(...w);
        failNext = false;
        throw new Error("listener boom");
      },
    };
    const { watcher } = createTranscriptWatcher("s9", emitter, () => sink);
    const path = tmpFile();
    writeFileSync(path, "");
    watcher.observe(path);
    writeFileSync(path, "{ bad }\n");
    expect(() => watcher.scan()).not.toThrow(); // first scan's delivery throws, contained
    expect(recorded).toEqual([]); // the dropped warning was NOT retained
    writeFileSync(path, "{ also-bad }\n");
    watcher.scan(); // a later scan's OWN drop delivers (the first was dropped, not retried)
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.code).toBe("transcript_records_dropped");
  });

  test("with a warning sink, a drop is routed through emitWarnings as a live warning", () => {
    const activities: ElwoodActivityEvent[] = [];
    const emitter = fakeEmitter((a) => activities.push(a));
    const recorded: ElwoodWarningEvent[] = [];
    const sink: WarningSink = { emitWarnings: (w) => recorded.push(...w) };
    const { watcher } = createTranscriptWatcher("s9", emitter, () => sink);
    const path = tmpFile();
    writeFileSync(path, "");
    watcher.observe(path);
    writeFileSync(path, "{ bad }\n");
    watcher.finish();
    // The drop went to the sink (live warning/activity contract), NOT emitted as
    // a raw activity by the watcher itself.
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      code: "transcript_records_dropped",
      agent: "claude",
      cause: "unparseable",
      transcriptPath: path,
    });
    expect(activities).not.toContainEqual(expect.objectContaining({ kind: "warning" }));
  });

  test("a contained fs read error is routed to the sink as a transcript_read_error warning", () => {
    const emitter = fakeEmitter();
    const recorded: ElwoodWarningEvent[] = [];
    const sink: WarningSink = { emitWarnings: (w) => recorded.push(...w) };
    const { watcher } = createTranscriptWatcher("s9", emitter, () => sink);
    const path = tmpFile();
    writeFileSync(path, "");
    watcher.observe(path);
    rmSync(path);
    mkdirSync(path); // reads now throw EISDIR: contained and surfaced, not silent
    watcher.scan();
    watcher.finish();
    expect(recorded.at(-1)).toMatchObject({
      code: "transcript_read_error",
      agent: "claude",
      lastErrorCode: expect.any(String),
      transcriptPath: path,
    });
  });

  test("§5.4 a poll that finds the watcher finished in its finally discards, never flushes", async () => {
    // Drives the poll's finished-guarded finally: a poll begins, finish() lands during its
    // awaited stat (draining + latching terminal:exit), and when the poll resumes it bails
    // and its finally must DISCARD the pass rather than flush past the terminal latch.
    // (The FULL interleaving — a drop scanned by cursor A, then finish() during cursor B's
    // await, leaving A's drop pending — cannot be triggered deterministically without an
    // fs-timing seam: pollOnceForTests runs synchronously only to the first await, so an
    // external finish() always lands there. The discard BRANCH is covered here; the
    // DropReporter.discardPass unit test covers the discard semantics directly.)
    const recorded: ElwoodWarningEvent[] = [];
    const sink: WarningSink = { emitWarnings: (w) => recorded.push(...w) };
    const { watcher } = createTranscriptWatcher("s9", fakeEmitter(), () => sink);
    const path = tmpFile();
    writeFileSync(path, "");
    watcher.observe(path);
    writeFileSync(path, "{ bad-a }\n"); // one unparseable record
    const polling = watcher.pollOnceForTests(); // runs to the first awaited stat
    watcher.finish(); // lands during the await: drains the record once, then latches
    await polling; // resumes finished: bails; finally takes the discard branch
    const drops = recorded.filter((w) => w.code === "transcript_records_dropped");
    expect(drops).toHaveLength(1); // exactly the finish-drain drop — never a second, post-exit one
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
