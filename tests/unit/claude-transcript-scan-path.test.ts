/**
 * A held Claude `Stop` reads only its own transcript, and only a read that reached its end with no
 * record partly written can show that Claude wrote no queued-turn record (PRD §6.5, C-HOOK-24).
 * The hold's reads leave failures and drops for the watcher's poll to report.
 */
import { appendFileSync } from "node:fs";
import { afterEach, expect, test } from "vitest";
import {
  type ClaudeTranscriptEvent,
  ClaudeTranscriptWatcher,
  type TranscriptReadErrorNotice,
} from "../../src/claude/transcript/index.ts";
import {
  readTranscriptBytes,
  resetByteReaderForTests,
  setByteReaderForTests,
  withTranscriptFile,
} from "../../src/core/transcript/cursor-io.ts";
import {
  appendRecords,
  assistant,
  texts,
  tmpFile,
  writeRecords,
} from "./claude-transcript-helpers.ts";

afterEach(resetByteReaderForTests);

function watched() {
  const events: ClaudeTranscriptEvent[] = [];
  const readErrors: TranscriptReadErrorNotice[] = [];
  const watcher = new ClaudeTranscriptWatcher("s1", (event) => events.push(event), {
    onReadError: (notice) => readErrors.push(notice),
  });
  const path = tmpFile();
  writeRecords(path);
  watcher.observe(path);
  return { watcher, path, events, readErrors };
}

test("C-HOOK-24 a hold read reaches the end only after a backlog, and reads no other transcript", () => {
  const { watcher, path, events } = watched();
  const other = tmpFile();
  writeRecords(other);
  watcher.observe(other);
  appendRecords(other, [], assistant("other"));
  const backlog = Array.from({ length: 3 }, (_, index) =>
    assistant(`${index}${"b".repeat(200_000)}`),
  );
  appendRecords(path, [], ...backlog);
  const reads = [watcher.scanPath(path, 1), watcher.scanPath(path, 1), watcher.scanPath(path, 1)];
  expect(reads).toEqual([false, false, true]);
  expect(texts(events)).toHaveLength(3);
  expect(texts(events)).not.toContain("other");
  watcher.finish();
});

test("C-HOOK-24 a failed hold read is not the end and reports nothing; the poll reports it", async () => {
  const { watcher, path, events, readErrors } = watched();
  appendRecords(path, [], assistant("late"));
  setByteReaderForTests(() => {
    throw Object.assign(new Error("injected"), { code: "EIO" });
  });
  expect(watcher.scanPath(path, 1)).toBe(false);
  expect(readErrors).toEqual([]);
  await watcher.pollOnceForTests();
  expect(readErrors).toMatchObject([{ path, lastErrorCode: "EIO" }]);
  setByteReaderForTests((file, start, length) =>
    withTranscriptFile(file, (fd) => readTranscriptBytes(fd, start, length)),
  );
  expect(watcher.scanPath(path, 1)).toBe(true);
  expect(texts(events)).toEqual(["late"]);
  watcher.finish();
});

test("C-HOOK-24 an incomplete UTF-8 tail, a partial record, or an oversized one is not the end", () => {
  const { watcher, path, events } = watched();
  const record = JSON.stringify(assistant("€"));
  const euro = Buffer.from("€");
  appendFileSync(path, `${JSON.stringify(assistant("whole"))}\n`);
  appendFileSync(path, euro.subarray(0, 2));
  expect(watcher.scanPath(path, 1)).toBe(false); // the code point's last byte is unwritten
  appendFileSync(path, Buffer.concat([euro.subarray(2), Buffer.from(`\n${record.slice(0, 10)}`)]));
  expect(watcher.scanPath(path, 1)).toBe(false); // a record without its newline yet
  appendFileSync(path, `${record.slice(10)}\n`);
  expect(watcher.scanPath(path, 1)).toBe(true);
  appendFileSync(path, "y".repeat(1024 * 1024 + 1024));
  expect(watcher.scanPath(path, 8)).toBe(false); // discarding an oversized record through its newline
  appendFileSync(path, "\n");
  expect(watcher.scanPath(path, 1)).toBe(true);
  expect(texts(events)).toEqual(["whole", "€"]);
  watcher.finish();
});

test("C-HOOK-24 an unobserved transcript, a missing path, or a finished watcher is never read to its end", () => {
  const { watcher, path } = watched();
  expect(watcher.scanPath(tmpFile(), 1)).toBe(false);
  expect(watcher.scanPath(undefined, 1)).toBe(false);
  watcher.finish();
  expect(watcher.scanPath(path, 1)).toBe(false);
});
