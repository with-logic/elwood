/** Hook observation preserves or supersedes a pending Codex resume baseline (C-STATE-15). */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { seedCodexResumeCursor } from "../../src/codex/transcript/resume-cursor.ts";
import { CodexTranscriptWatcher } from "../../src/codex/transcript/watcher.ts";
import { tempDirForUnit } from "./helpers.ts";

const nativeSessionId = "native";
const header = `${JSON.stringify({ type: "session_meta", payload: { id: nativeSessionId } })}\n`;

function preparedWatcher() {
  const dir = tempDirForUnit();
  const path = join(dir, "saved.jsonl");
  writeFileSync(path, header);
  const seen: unknown[] = [];
  const watcher = new CodexTranscriptWatcher("session", ({ item }) => seen.push(item));
  watcher.seedResume(seedCodexResumeCursor(path, nativeSessionId));
  return { watcher, seen, path, dir };
}

test("C-STATE-15 a hook naming the saved rollout preserves the pre-PTY EOF", () => {
  const { watcher, seen, path } = preparedWatcher();
  appendFileSync(path, '{"type":"new"}\n');
  watcher.observe(path);
  watcher.scan();
  expect(seen).toEqual([]);
  watcher.startSeededResume();
  watcher.finish();
  expect(seen).toEqual([{ type: "new" }]);
});

test("C-STATE-15 a hook naming another rollout supersedes the saved path", () => {
  const { watcher, seen, path, dir } = preparedWatcher();
  const current = join(dir, "current.jsonl");
  writeFileSync(current, header);
  watcher.observe(current);
  watcher.startSeededResume();

  appendFileSync(path, '{"type":"wrong"}\n');
  appendFileSync(current, '{"type":"current"}\n');
  watcher.finish();
  expect(seen).toEqual([{ type: "current" }]);
});

test("C-STATE-15 ending a pending launch discards its baseline", () => {
  const { watcher, seen, path } = preparedWatcher();
  appendFileSync(path, '{"type":"failed-startup"}\n');
  watcher.finish();
  watcher.startSeededResume();
  watcher.scan();
  expect(seen).toEqual([]);
});
