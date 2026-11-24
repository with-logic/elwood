/** Verify the file identity and EOF of saved Codex resume transcripts (C-STATE-15). */
import {
  appendFileSync,
  chmodSync,
  renameSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { seedCodexResumeCursor } from "../../src/codex/transcript/resume-cursor.ts";
import { tempDirForUnit } from "./helpers.ts";

const nativeSessionId = "native-session";
const header = `${JSON.stringify({ type: "session_meta", payload: { id: nativeSessionId } })}\n`;

function createRollout(contents = header) {
  const dir = tempDirForUnit();
  const path = join(dir, "rollout.jsonl");
  writeFileSync(path, contents);
  return { dir, path };
}

test("C-STATE-15 reads only new bytes from the verified resume rollout", () => {
  const { path } = createRollout(`${header}{"type":"old"}\n`);
  const cursor = seedCodexResumeCursor(path, nativeSessionId)!;
  expect(cursor.readLiveChunk()).toEqual({ text: "", canContinueNow: false });
  const appended = '{"type":"new"}\n';
  appendFileSync(path, appended);
  expect(cursor.remainingBytes()).toBe(Buffer.byteLength(appended));
  expect(cursor.readLiveChunk()).toEqual({ text: appended, canContinueNow: false });
  expect(cursor.remainingBytes()).toBe(0);
});

test.each([
  ["malformed header", "{\n"],
  ["non-object header", "null\n"],
  ["wrong event type", '{"type":"other"}\n'],
  ["missing metadata ID", '{"type":"session_meta"}\n'],
  ["mismatched metadata ID", '{"type":"session_meta","payload":{"id":"other"}}\n'],
  ["no newline within the bounded header", `${header.trimEnd().padEnd(256 * 1024)}\n`],
])("C-STATE-15 rejects a rollout with %s", (_case, contents) => {
  const { path } = createRollout(contents);
  expect(seedCodexResumeCursor(path, nativeSessionId)).toBeUndefined();
});

test("C-STATE-15 rejects missing, non-regular, linked, and group-writable rollouts", () => {
  const { dir, path } = createRollout();
  const symlink = join(dir, "linked.jsonl");
  symlinkSync(path, symlink);
  expect(seedCodexResumeCursor(join(dir, "missing.jsonl"), nativeSessionId)).toBeUndefined();
  expect(seedCodexResumeCursor(dir, nativeSessionId)).toBeUndefined();
  expect(seedCodexResumeCursor(symlink, nativeSessionId)).toBeUndefined();
  chmodSync(path, 0o622);
  expect(seedCodexResumeCursor(path, nativeSessionId)).toBeUndefined();
});

test("C-STATE-15 rejects a rollout owned by another user", () => {
  const { path } = createRollout();
  const uid = vi.spyOn(process, "getuid").mockReturnValue(process.getuid!() + 1);
  try {
    expect(seedCodexResumeCursor(path, nativeSessionId)).toBeUndefined();
  } finally {
    uid.mockRestore();
  }
});

test("C-STATE-15 refuses to read a replacement at a seeded transcript path", () => {
  const { dir, path } = createRollout();
  const cursor = seedCodexResumeCursor(path, nativeSessionId)!;
  renameSync(path, join(dir, "original.jsonl"));
  writeFileSync(path, `${header}{"type":"replacement"}\n`);
  expect(() => cursor.readLiveChunk()).toThrow(expect.objectContaining({ code: "ESTALE" }));
});

test("C-STATE-15 refuses to replay data after a seeded transcript truncates", () => {
  const { path } = createRollout();
  const cursor = seedCodexResumeCursor(path, nativeSessionId)!;
  truncateSync(path, 0);
  expect(() => cursor.readLiveChunk()).toThrow(expect.objectContaining({ code: "ESTALE" }));
});
