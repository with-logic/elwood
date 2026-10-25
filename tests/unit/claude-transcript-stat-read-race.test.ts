/**
 * A Claude transcript removed between a poll's stat and its read is a removal, not a
 * truncation: the poll warns, and a file restored before the next poll is not replayed
 * from the start (PRD §5.4 / §5.7, C-CLAUDE-24).
 */

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { TranscriptCursor } from "../../src/claude/transcript/cursor.ts";
import {
  type ClaudeTranscriptEvent,
  ClaudeTranscriptWatcher,
  type TranscriptReadErrorNotice,
} from "../../src/claude/transcript/index.ts";
import {
  appendRecords,
  assistant,
  texts,
  tmpFile,
  writeRecords,
} from "./claude-transcript-helpers.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

test("C-CLAUDE-24 a transcript removed between the poll's stat and its read warns without replay", async () => {
  const path = tmpFile();
  const before = [assistant("before"), assistant("seen")];
  writeRecords(path, before[0]); // existed at observe: the cursor starts at its end
  const events: ClaudeTranscriptEvent[] = [];
  const readErrors: TranscriptReadErrorNotice[] = [];
  const watcher = new ClaudeTranscriptWatcher("s1", (event) => events.push(event), {
    onReadError: (notice) => readErrors.push(notice),
  });
  try {
    watcher.observe(path);
    appendRecords(path, [before[0]], before[1]);
    await watcher.pollOnceForTests();
    appendRecords(path, before, assistant("grown"));
    const restored = readFileSync(path);
    // The poll's stat sees the growth; the file is gone by the time it reads.
    const needsScan = TranscriptCursor.prototype.needsScan;
    vi.spyOn(TranscriptCursor.prototype, "needsScan").mockImplementationOnce(async function (
      this: TranscriptCursor,
    ) {
      const changed = await needsScan.call(this);
      rmSync(path);
      return changed;
    });
    await watcher.pollOnceForTests();
    expect(readErrors).toEqual([{ elwoodSessionId: "s1", path, lastErrorCode: "ENOENT" }]);
    writeFileSync(path, restored); // back before the next poll
    await watcher.pollOnceForTests();
    expect(texts(events)).toEqual(["seen", "grown"]);
  } finally {
    watcher.finish();
  }
});
