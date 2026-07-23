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
  type ObservableTranscript,
  observeTranscript,
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
  test("observeTranscript follows BOTH transcript_path and agent_transcript_path", () => {
    const observed: [string, boolean][] = [];
    const watcher: ObservableTranscript = {
      observe: (p, recover) => observed.push([p, recover ?? false]),
      retire: () => {},
    };
    // A Stop is a turn boundary, so a first observe recovers the committed tail.
    observeTranscript(watcher, {
      hook_event_name: "Stop",
      transcript_path: "/main.jsonl",
      agent_transcript_path: "/sub.jsonl",
    });
    observeTranscript(watcher, {}); // neither present: ignored
    observeTranscript(watcher, { transcript_path: "" }); // empty: ignored
    expect(observed).toEqual([
      ["/main.jsonl", true],
      ["/sub.jsonl", true],
    ]);
  });

  test("observeTranscript does NOT recover history on a non-boundary hook", () => {
    const observed: [string, boolean][] = [];
    const watcher: ObservableTranscript = {
      observe: (p, recover) => observed.push([p, recover ?? false]),
      retire: () => {},
    };
    // A SessionStart/resume observe baselines at EOF: no backward recovery, so a
    // resumed session never republishes the prior conversation's final turn.
    observeTranscript(watcher, {
      hook_event_name: "SessionStart",
      transcript_path: "/main.jsonl",
    });
    expect(observed).toEqual([["/main.jsonl", false]]);
  });

  test("SubagentStop observes then RETIRES the agent transcript from active polling", () => {
    const observed: string[] = [];
    const retired: string[] = [];
    const watcher: ObservableTranscript = {
      observe: (p) => observed.push(p),
      retire: (p) => retired.push(p),
    };
    observeTranscript(watcher, {
      hook_event_name: "SubagentStop",
      transcript_path: "/main.jsonl",
      agent_transcript_path: "/sub.jsonl",
    });
    // Both observed; only the one-shot agent transcript is retired.
    expect(observed).toEqual(["/main.jsonl", "/sub.jsonl"]);
    expect(retired).toEqual(["/sub.jsonl"]);
  });

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
    sink = { recordWarnings: (w) => recorded.push(...w) };
    flushPendingWarnings();
    expect(recorded.some((w) => w.code === "transcript_records_dropped")).toBe(true);
  });

  test("§5.4 a throwing recordWarnings keeps the buffered notice queued — a retry re-delivers", () => {
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
      recordWarnings: (w) => {
        if (!failNext) return void recorded.push(...w);
        failNext = false;
        throw new Error("persist boom");
      },
    };
    expect(() => flushPendingWarnings()).toThrow(/persist boom/);
    expect(recorded).toEqual([]); // the throw must not have lost the notice
    flushPendingWarnings(); // the still-queued notice re-delivers
    expect(recorded.some((w) => w.code === "transcript_records_dropped")).toBe(true);
  });

  test("with a warning sink, a drop is routed through recordWarnings (persist + dedup)", () => {
    const activities: ElwoodActivityEvent[] = [];
    const emitter = fakeEmitter((a) => activities.push(a));
    const recorded: ElwoodWarningEvent[] = [];
    const sink: WarningSink = { recordWarnings: (w) => recorded.push(...w) };
    const { watcher } = createTranscriptWatcher("s9", emitter, () => sink);
    const path = tmpFile();
    writeFileSync(path, "");
    watcher.observe(path);
    writeFileSync(path, "{ bad }\n");
    watcher.finish();
    // The drop went to the sink (persist/dedup/warning contract), NOT emitted as
    // a raw activity by the watcher itself.
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      code: "transcript_records_dropped",
      agent: "claude",
      droppedCount: 1,
      transcriptPath: path,
    });
    expect(activities).not.toContainEqual(expect.objectContaining({ kind: "warning" }));
  });

  test("a contained fs read error is routed to the sink as a transcript_read_error warning", () => {
    const emitter = fakeEmitter();
    const recorded: ElwoodWarningEvent[] = [];
    const sink: WarningSink = { recordWarnings: (w) => recorded.push(...w) };
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
      errorCount: expect.any(Number),
      transcriptPath: path,
    });
  });

  test("a timer-path listener error is routed to the sink as a transcript_poll_stopped warning", async () => {
    const recorded: ElwoodWarningEvent[] = [];
    const sink: WarningSink = { recordWarnings: (w) => recorded.push(...w) };
    // The transcript event emitter throws — a programming error on the timer path.
    const emitter = fakeEmitter((a) => {
      if (a.kind === "assistant_message") throw new Error("listener bug");
    });
    // A short poll cadence via the seam + waitFor makes the timer-path assertion
    // deterministic, not a fixed sleep race (the pattern used in the recovery tests).
    const { watcher } = createTranscriptWatcher("s9", emitter, () => sink, {}, 5);
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
