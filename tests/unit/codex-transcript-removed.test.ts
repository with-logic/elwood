/**
 * A Codex transcript removed after it existed is a read race that warns, not a truncation;
 * one not created yet waits silently (PRD §5.7, C-CODEX-23). Mirrors C-CLAUDE-24.
 */

import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { CodexTranscriptWatcher } from "../../src/codex/transcript/index.ts";
import * as cursorIo from "../../src/core/transcript/cursor-io.ts";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  cursorIo.resetByteReaderForTests();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function record(label: string): string {
  return `${JSON.stringify({ type: "event_msg", payload: { type: label } })}\n`;
}

function watch(path: string) {
  const errors: string[] = [];
  const labels: string[] = [];
  const watcher = new CodexTranscriptWatcher("s", (event) => labels.push(event.summary.label), {
    onReadError: (notice) => errors.push(notice.lastErrorCode),
    scanIntervalMs: 3_600_000, // scans are driven by hand
  });
  watcher.observe(path);
  return { watcher, errors, labels };
}

function transcriptPath(): string {
  const root = mkdtempSync(join(tmpdir(), "codex-removed-"));
  roots.push(root);
  return join(root, "rollout.jsonl");
}

test("C-CODEX-23 a transcript not created yet waits silently, then its first record is read", () => {
  const path = transcriptPath();
  const { watcher, errors, labels } = watch(path);
  watcher.scan();
  watcher.scan();
  writeFileSync(path, record("task_started"));
  watcher.scan();
  expect({ errors, labels }).toEqual({ errors: [], labels: ["task_started"] });
  watcher.finish();
});

test("C-CODEX-23 removal after a scan saw the file warns on each poll until a file is back", () => {
  const path = transcriptPath();
  const { watcher, errors, labels } = watch(path);
  writeFileSync(path, record("first"));
  watcher.scan();
  unlinkSync(path);
  watcher.scan();
  watcher.scan();
  expect(errors).toEqual(["ENOENT", "ENOENT"]);
  // Once a file is back, the warnings stop; a shorter one reads as a truncation, as before.
  writeFileSync(path, record("a"));
  watcher.scan();
  expect({ errors, labels }).toEqual({ errors: ["ENOENT", "ENOENT"], labels: ["first", "a"] });
  watcher.finish();
});

test("C-CODEX-23 a file that existed at registration and was then removed warns", () => {
  const path = transcriptPath();
  writeFileSync(path, "");
  const { watcher, errors } = watch(path);
  unlinkSync(path);
  watcher.scan();
  expect(errors).toEqual(["ENOENT"]);
  watcher.finish();
});

test("C-CODEX-23 registration and existence come from one stat", () => {
  const path = transcriptPath();
  writeFileSync(path, record("history"));
  // The registration stat sees the file; it is gone before any later check.
  vi.spyOn(cursorIo, "observedSize").mockImplementationOnce(() => {
    const size = Buffer.byteLength(record("history"));
    unlinkSync(path);
    return size;
  });
  const { watcher, errors } = watch(path);
  watcher.scan();
  expect(errors).toEqual(["ENOENT"]);
  watcher.finish();
});

test("C-CODEX-23 a non-ENOENT failure warns before the file was ever seen", () => {
  const path = transcriptPath();
  const { watcher, errors } = watch(join(path, "nested.jsonl"));
  writeFileSync(path, "not a directory");
  watcher.scan();
  expect(errors).toEqual(["ENOTDIR"]);
  watcher.finish();
});

test("C-CODEX-23 a removal between a scan's reads warns and is never read as a truncation", () => {
  const path = transcriptPath();
  writeFileSync(path, "");
  const { watcher, errors, labels } = watch(path);
  // More than one 256 KiB read, so one scan reads the file twice.
  const names = Array.from({ length: 8_000 }, (_, index) => `r${index}`);
  const content = names.map(record).join("");
  writeFileSync(path, content);
  let reads = 0;
  cursorIo.setByteReaderForTests((file, start, length) => {
    const bytes = readFileSync(file).subarray(start, start + length);
    reads += 1;
    if (reads === 1) unlinkSync(file); // gone after the scan's first read
    return bytes;
  });
  watcher.scan();
  expect(errors).toEqual(["ENOENT"]);
  writeFileSync(path, content); // back before the next scan: resumes, no replay
  watcher.scan();
  watcher.scan();
  expect({ errors, labels }).toEqual({ errors: ["ENOENT"], labels: names });
  watcher.finish();
});

test("C-CODEX-23 the final flush reports a removed transcript but not one never created", () => {
  const removed = transcriptPath();
  const seen = watch(removed);
  writeFileSync(removed, record("first"));
  seen.watcher.scan();
  unlinkSync(removed);
  seen.watcher.finish(); // the final flush reads the removed file
  const never = watch(transcriptPath());
  never.watcher.finish();
  expect({ removed: seen.errors, never: never.errors }).toEqual({
    removed: ["ENOENT"],
    never: [],
  });
});
