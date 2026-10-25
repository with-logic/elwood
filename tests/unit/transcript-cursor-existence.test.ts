/**
 * The shared transcript cursor's existence policy for live reads (PRD §5.7, C-CLAUDE-24):
 * a file not created yet reads nothing, while ENOENT after the file existed, and any other
 * stat failure, throws for the caller's fs guard.
 */

import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { BoundedTranscriptCursor } from "../../src/core/transcript/cursor.ts";
import { tempDirForUnit } from "./helpers.ts";

test("C-CLAUDE-24 readLive waits on a file not created yet, then reads it, then throws on removal", () => {
  const path = join(tempDirForUnit(), "t.jsonl");
  const cursor = new BoundedTranscriptCursor(path);
  expect(cursor.readLive()).toEqual({ text: "", canContinueNow: false });
  writeFileSync(path, "first\n");
  expect(cursor.readLive()).toEqual({ text: "first\n", canContinueNow: false });
  rmSync(path);
  expect(() => cursor.readLive()).toThrow(expect.objectContaining({ code: "ENOENT" }));
});

test("C-CLAUDE-24 readLive rethrows a non-ENOENT failure before the file was ever seen", () => {
  const parent = join(tempDirForUnit(), "parent");
  const cursor = new BoundedTranscriptCursor(join(parent, "t.jsonl"));
  writeFileSync(parent, ""); // a FILE where the transcript's directory should be
  expect(() => cursor.readLive()).toThrow(expect.objectContaining({ code: "ENOTDIR" }));
});
