/**
 * A Claude transcript scan reports whether it read every transcript to its end, which bounds a
 * held `Stop`'s deadline behind a backlog (PRD §6.5, C-HOOK-24; §9.2 scan budget).
 */
import { expect, test } from "vitest";
import {
  type ClaudeTranscriptEvent,
  ClaudeTranscriptWatcher,
} from "../../src/claude/transcript/index.ts";
import {
  appendRecords,
  assistant,
  texts,
  tmpFile,
  writeRecords,
} from "./claude-transcript-helpers.ts";

test("C-HOOK-24 a scan whose budget runs out before a later transcript has not reached the end", () => {
  const events: ClaudeTranscriptEvent[] = [];
  const watcher = new ClaudeTranscriptWatcher("s1", (event) => events.push(event));
  const first = tmpFile();
  const second = tmpFile();
  writeRecords(first);
  writeRecords(second);
  watcher.observe(first);
  watcher.observe(second);
  appendRecords(first, [], assistant("first"));
  appendRecords(second, [], assistant("second"));
  // One chunk reads the first transcript to its end, leaving none for the second.
  expect(watcher.scan(1)).toBe(false);
  expect(texts(events)).toEqual(["first"]);
  expect(watcher.scan(1)).toBe(true);
  expect(texts(events)).toEqual(["first", "second"]);
  watcher.finish();
});
