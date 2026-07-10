/**
 * Coverage for wiring the Claude transcript watcher into the session stream.
 * Covers PRD §5.4 (C-CLAUDE-15): both transcript paths observed; drops surfaced.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createTranscriptWatcher,
  observeTranscript,
  type WarningSink,
} from "../../src/claude/session-transcript.ts";
import type { ElwoodWarningEvent } from "../../src/core/types.ts";

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
    const watcher = {
      observe: (p: string, recover: boolean) => observed.push([p, recover]),
    } as never;
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
    const watcher = {
      observe: (p: string, recover: boolean) => observed.push([p, recover]),
    } as never;
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
    const watcher = {
      observe: (p: string) => observed.push(p),
      retire: (p: string) => retired.push(p),
    } as never;
    observeTranscript(watcher, {
      hook_event_name: "SubagentStop",
      transcript_path: "/main.jsonl",
      agent_transcript_path: "/sub.jsonl",
    });
    // Both observed; only the one-shot agent transcript is retired.
    expect(observed).toEqual(["/main.jsonl", "/sub.jsonl"]);
    expect(retired).toEqual(["/sub.jsonl"]);
  });

  test("a drop observed before the sink exists is BUFFERED, then flushed once it does", () => {
    const activities: Array<{ kind?: string; label?: string }> = [];
    const emitter = { emit: (_e: string, a: never) => activities.push(a) } as never;
    const recorded: ElwoodWarningEvent[] = [];
    let sink: WarningSink | undefined; // not ready yet (early startup)
    const watcher = createTranscriptWatcher("s9", emitter, () => sink);
    const path = tmpFile();
    writeFileSync(path, "");
    watcher.observe(path);
    writeFileSync(path, `${JSON.stringify(assistant("wired"))}\n{ bad }\n`);
    watcher.scan();
    // Sink absent: the drop is NOT emitted as an activity-only warning (which
    // would neither persist nor replay) — it is held.
    expect(activities).not.toContainEqual(expect.objectContaining({ kind: "warning" }));
    // The sink appears; the next diagnostic flushes the buffered one through it.
    sink = { recordWarnings: (w) => recorded.push(...w) };
    writeFileSync(path, `${JSON.stringify(assistant("wired"))}\n{ bad }\n{ bad2 }\n`);
    watcher.finish();
    expect(recorded.some((w) => w.code === "transcript_records_dropped")).toBe(true);
  });

  test("with a warning sink, a drop is routed through recordWarnings (persist + dedup)", () => {
    const activities: Array<{ kind?: string }> = [];
    const emitter = { emit: (_e: string, a: never) => activities.push(a) } as never;
    const recorded: ElwoodWarningEvent[] = [];
    const sink: WarningSink = { recordWarnings: (w) => recorded.push(...w) };
    const watcher = createTranscriptWatcher("s9", emitter, () => sink);
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
    const emitter = { emit: () => {} } as never;
    const recorded: ElwoodWarningEvent[] = [];
    const sink: WarningSink = { recordWarnings: (w) => recorded.push(...w) };
    const watcher = createTranscriptWatcher("s9", emitter, () => sink);
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
    const emitter = {
      emit: (_e: string, a: { kind?: string }) => {
        if (a.kind === "assistant_message") throw new Error("listener bug");
      },
    } as never;
    const watcher = createTranscriptWatcher("s9", emitter, () => sink);
    const path = tmpFile();
    writeFileSync(path, "");
    watcher.observe(path);
    writeFileSync(path, `${JSON.stringify(assistant("boom"))}\n`);
    await new Promise((resolve) => setTimeout(resolve, 700)); // one poll tick
    watcher.finish();
    expect(recorded.some((w) => w.code === "transcript_poll_stopped")).toBe(true);
  });
});
