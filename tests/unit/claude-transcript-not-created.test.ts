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

test("C-CLAUDE-24 a non-ENOENT poll failure before creation still reports its code", async () => {
  const parent = tmpFile(); // absent at observe: the transcript is simply not created yet
  const path = join(parent, "t.jsonl");
  const { watcher, readErrors } = watch();
  watcher.observe(path);
  await watcher.pollOnceForTests();
  expect(readErrors).toEqual([]);
  writeFileSync(parent, ""); // now a FILE where the transcript's directory should be
  await watcher.pollOnceForTests(); // the poll's own stat fails with ENOTDIR
  expect(readErrors).toEqual([{ elwoodSessionId: "s1", path, lastErrorCode: "ENOTDIR" }]);
  watcher.finish();
});

test("C-CLAUDE-24 retiring a seen subagent transcript after its removal reports ENOENT", async () => {
  const path = tmpFile();
  const { watcher, readErrors } = watch();
  watcher.observe(path);
  writeRecords(path, assistant("seen"));
  await watcher.pollOnceForTests();
  rmSync(path);
  watcher.retire(path); // its final drain reads the removed file
  expect(readErrors).toEqual([{ elwoodSessionId: "s1", path, lastErrorCode: "ENOENT" }]);
  watcher.finish();
});

test("C-CLAUDE-24 the final flush reports a removed transcript but not one never created", async () => {
  const removed = tmpFile();
  const never = tmpFile();
  const { watcher, readErrors } = watch();
  watcher.observe(removed);
  watcher.observe(never);
  writeRecords(removed, assistant("seen"));
  await watcher.pollOnceForTests();
  rmSync(removed);
  watcher.finish();
  expect(readErrors).toEqual([{ elwoodSessionId: "s1", path: removed, lastErrorCode: "ENOENT" }]);
});

test("C-CLAUDE-24 a transcript truncated to empty, then removed, still reports ENOENT", async () => {
  const path = tmpFile();
  const { watcher, readErrors } = watch();
  watcher.observe(path);
  writeRecords(path, assistant("seen"));
  await watcher.pollOnceForTests();
  writeRecords(path); // truncated to zero bytes: the next read rewinds without opening it
  await watcher.pollOnceForTests();
  expect(readErrors).toEqual([]);
  rmSync(path);
  await watcher.pollOnceForTests();
  expect(readErrors).toEqual([{ elwoodSessionId: "s1", path, lastErrorCode: "ENOENT" }]);
  watcher.finish();
});

test("C-CLAUDE-24 a Stop-first observe of a transcript not created yet recovers nothing silently", async () => {
  const path = tmpFile();
  const { watcher, events, readErrors } = watch();
  watcher.observe(path, true); // the baseline-tail recovery finds no file yet
  writeRecords(path, assistant("first turn"));
  await watcher.pollOnceForTests();
  expect({ texts: texts(events), readErrors }).toEqual({ texts: ["first turn"], readErrors: [] });
  watcher.finish();
});
