/**
 * The Claude cursor decides "has this transcript existed" from the same stat that sets its
 * start offset, so a file removed between two separate checks cannot be mistaken for one
 * not created yet and lose its removal warning, whether a poll or the Stop-first
 * baseline recovery reads it next (PRD §5.7, C-CLAUDE-24).
 */

import { afterEach, expect, test, vi } from "vitest";
import {
  ClaudeTranscriptWatcher,
  type TranscriptReadErrorNotice,
} from "../../src/claude/transcript/index.ts";
import { tmpFile } from "./claude-transcript-helpers.ts";

// The path whose registration stat "sees" a 5-byte file that is gone by any later check:
// the first stat of it consumes the sighting.
const seen = vi.hoisted(() => ({ path: undefined as string | undefined }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const statSync = ((path: Parameters<typeof actual.statSync>[0], ...rest: unknown[]) => {
    if (path !== seen.path) return Reflect.apply(actual.statSync, actual, [path, ...rest]);
    seen.path = undefined;
    return { size: 5 };
  }) as typeof actual.statSync;
  return { ...actual, statSync };
});

afterEach(() => {
  seen.path = undefined;
});

test("C-CLAUDE-24 a transcript removed right after the registration stat still warns", async () => {
  const path = tmpFile(); // never on disk: only the registration stat saw it
  seen.path = path;
  const readErrors: TranscriptReadErrorNotice[] = [];
  const watcher = new ClaudeTranscriptWatcher("s1", () => undefined, {
    onReadError: (notice) => readErrors.push(notice),
  });
  watcher.observe(path); // the registration stat sees it; every later check finds nothing
  await watcher.pollOnceForTests();
  expect(readErrors).toEqual([{ elwoodSessionId: "s1", path, lastErrorCode: "ENOENT" }]);
  watcher.finish();
});

test("C-CLAUDE-24 a Stop-first baseline of a transcript removed after registration warns", () => {
  const path = tmpFile(); // never on disk: only the registration stat saw it
  seen.path = path;
  const readErrors: TranscriptReadErrorNotice[] = [];
  const watcher = new ClaudeTranscriptWatcher("s1", () => undefined, {
    onReadError: (notice) => readErrors.push(notice),
  });
  watcher.observe(path, true); // the baseline-tail recovery reads the removed file
  expect(readErrors).toEqual([{ elwoodSessionId: "s1", path, lastErrorCode: "ENOENT" }]);
  watcher.finish();
});
