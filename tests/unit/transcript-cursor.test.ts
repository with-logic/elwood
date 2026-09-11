/**
 * Unit tests for the shared bounded transcript cursor (PRD §5.4, C-CLAUDE-15): a truncated
 * file restarts the cursor AND discards the old file's buffered partial line and any
 * in-progress oversized discard, so stale bytes never prefix the new file's first record.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { BoundedTranscriptCursor } from "../../src/core/transcript/cursor.ts";

function transcript(initial: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "elwood-cursor-")), "t.jsonl");
  writeFileSync(path, initial);
  return path;
}

/** Reads every currently unread byte (across bounded chunks) and splits it into lines. */
function readAll(cursor: BoundedTranscriptCursor) {
  const lines: string[] = [];
  let startedOversizedDrop = false;
  for (;;) {
    const chunk = cursor.readChunk();
    const taken = cursor.takeLines(chunk.text);
    lines.push(...taken.lines);
    startedOversizedDrop ||= taken.startedOversizedDrop;
    if (!chunk.canContinueNow) return { lines, startedOversizedDrop };
  }
}
const readLines = (cursor: BoundedTranscriptCursor): readonly string[] => readAll(cursor).lines;

describe("BoundedTranscriptCursor", () => {
  test("C-CLAUDE-15 truncation drops the old file's buffered partial line", () => {
    const path = transcript("");
    const cursor = new BoundedTranscriptCursor(path);
    writeFileSync(path, '{"old":1}\n{"partial":'); // a complete line + an unterminated tail
    expect(readLines(cursor)).toEqual(['{"old":1}']);
    // The transcript is rotated: a SHORTER file replaces it (size < offset).
    writeFileSync(path, '{"new":2}\n');
    // Without the reset, the stale `{"partial":` would prefix the new file's first record.
    expect(readLines(cursor)).toEqual(['{"new":2}']);
  });

  test("C-CLAUDE-15 truncation ends an in-progress oversized discard", () => {
    const path = transcript("");
    const cursor = new BoundedTranscriptCursor(path);
    // An un-terminated record past the 1 MiB pending ceiling starts a discard-to-newline.
    writeFileSync(path, "x".repeat(1024 * 1024 + 1));
    expect(readAll(cursor)).toEqual({ lines: [], startedOversizedDrop: true });
    // Rotate to a short file whose first line has no newline yet, then complete it.
    writeFileSync(path, '{"a":1}');
    expect(readLines(cursor)).toEqual([]); // still partial (not discarded — the drop ended)
    writeFileSync(path, '{"a":1}\n');
    expect(readLines(cursor)).toEqual(['{"a":1}']); // the line survives intact
  });

  test("C-CLAUDE-15 the empty-truncation read commits the restarted offset", () => {
    const path = transcript("abc\n");
    const cursor = new BoundedTranscriptCursor(path); // starts at the current end (4)
    writeFileSync(path, ""); // truncated to nothing
    expect(cursor.readChunk()).toEqual({ text: "", canContinueNow: false });
    writeFileSync(path, "d\n");
    expect(readLines(cursor)).toEqual(["d"]);
  });
});
