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

  test("without a warning sink, a drop is projected as a bare warning activity", () => {
    const activities: Array<{ kind?: string; label?: string }> = [];
    const emitter = { emit: (_e: string, a: never) => activities.push(a) } as never;
    // No sink (the transient early-startup case before the session exists).
    const watcher = createTranscriptWatcher("s9", emitter);
    const path = tmpFile();
    writeFileSync(path, "");
    watcher.observe(path);
    writeFileSync(path, `${JSON.stringify(assistant("wired"))}\n{ bad }\n`);
    watcher.finish();
    expect(activities).toContainEqual(expect.objectContaining({ kind: "assistant_message" }));
    // The drop diagnostic is a warning activity labelled with its code.
    expect(activities).toContainEqual(
      expect.objectContaining({ kind: "warning", label: "transcript_records_dropped" }),
    );
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
});
