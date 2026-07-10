/**
 * Coverage for wiring the Claude transcript watcher into the session stream.
 * Covers PRD §5.4 (C-CLAUDE-15): both transcript paths observed; drops surfaced.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createTranscriptWatcher, observeTranscript } from "../../src/claude/session-transcript.ts";

const assistant = (text: string) => ({
  type: "assistant",
  message: { content: [{ type: "text", text }] },
});

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "elwood-tx-")), "t.jsonl");
}

describe("C-CLAUDE-15 transcript session wiring", () => {
  test("observeTranscript follows BOTH transcript_path and agent_transcript_path", () => {
    const observed: string[] = [];
    const watcher = { observe: (p: string) => observed.push(p) } as never;
    observeTranscript(watcher, {
      transcript_path: "/main.jsonl",
      agent_transcript_path: "/sub.jsonl",
    });
    observeTranscript(watcher, {}); // neither present: ignored
    observeTranscript(watcher, { transcript_path: "" }); // empty: ignored
    expect(observed).toEqual(["/main.jsonl", "/sub.jsonl"]);
  });

  test("createTranscriptWatcher emits transcript + drop activities onto the emitter", () => {
    const activities: Array<{ kind?: string; label?: string }> = [];
    const emitter = { emit: (_e: string, a: never) => activities.push(a) } as never;
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
});
