/**
 * A Claude transcript path named before the CLI creates the file is "not created", not a
 * contained read race, while a removal after the file existed still warns (PRD §5.7,
 * C-CLAUDE-24).
 */

import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  type ClaudeTranscriptEvent,
  ClaudeTranscriptWatcher,
  type TranscriptReadErrorNotice,
} from "../../src/claude/transcript/index.ts";
import { assistant, texts, tmpFile, writeRecords } from "./claude-transcript-helpers.ts";

function watch() {
  const events: ClaudeTranscriptEvent[] = [];
  const readErrors: TranscriptReadErrorNotice[] = [];
  const watcher = new ClaudeTranscriptWatcher("s1", (event) => events.push(event), {
    onReadError: (notice) => readErrors.push(notice),
  });
  return { watcher, events, readErrors };
}

test("C-CLAUDE-24 polling a transcript that is not created yet reports no read error", async () => {
  const path = tmpFile(); // SessionStart names it; the first turn creates it
  const { watcher, events, readErrors } = watch();
  watcher.observe(path);
  await watcher.pollOnceForTests();
  await watcher.pollOnceForTests();
  expect(readErrors).toEqual([]);
  writeRecords(path, assistant("first turn"));
  await watcher.pollOnceForTests();
  expect(texts(events)).toEqual(["first turn"]);
  expect(readErrors).toEqual([]);
  watcher.finish();
});

test("C-CLAUDE-24 removing a transcript after a poll saw it still reports ENOENT", async () => {
  const path = tmpFile();
  const { watcher, readErrors } = watch();
  watcher.observe(path);
  writeRecords(path, assistant("seen"));
  await watcher.pollOnceForTests(); // the poll's stat sees the file
  rmSync(path);
  await watcher.pollOnceForTests();
  expect(readErrors).toEqual([{ elwoodSessionId: "s1", path, lastErrorCode: "ENOENT" }]);
  watcher.finish();
});

test("C-CLAUDE-24 removing a transcript that existed at observe still reports ENOENT", async () => {
  const path = tmpFile();
  writeFileSync(path, ""); // existed (empty) before the watcher observed it
  const { watcher, readErrors } = watch();
  watcher.observe(path);
  rmSync(path);
  await watcher.pollOnceForTests();
  expect(readErrors).toEqual([{ elwoodSessionId: "s1", path, lastErrorCode: "ENOENT" }]);
  watcher.finish();
});

test("C-CLAUDE-24 a non-ENOENT failure before creation still reports its code", async () => {
  const parent = tmpFile();
  writeFileSync(parent, ""); // a FILE where the transcript's directory should be
  const path = join(parent, "t.jsonl");
  const { watcher, readErrors } = watch();
  watcher.observe(path);
  await watcher.pollOnceForTests();
  expect(readErrors).toEqual([{ elwoodSessionId: "s1", path, lastErrorCode: "ENOTDIR" }]);
  watcher.finish();
});
