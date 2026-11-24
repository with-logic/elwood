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

const shortReads = vi.hoisted(() => ({
  enabled: false,
  history: [] as Array<readonly [position: number | null, count: number]>,
}));

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    readSync(
      fd: number,
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number | null,
    ) {
      if (!shortReads.enabled) return fs.readSync(fd, buffer, offset, length, position);
      const count = fs.readSync(fd, buffer, offset, Math.min(length, 8), position);
      shortReads.history.push([position, count]);
      return count;
    },
  };
});

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

test("C-STATE-15 reads a split native header and stops after its newline", () => {
  const { path } = createRollout(`${header}{"type":"historical"}\n`);
  let cursor: ReturnType<typeof seedCodexResumeCursor>;
  shortReads.enabled = true;
  try {
    cursor = seedCodexResumeCursor(path, nativeSessionId);
  } finally {
    shortReads.enabled = false;
  }

  expect(cursor).toBeDefined();
  expect(shortReads.history.length).toBeGreaterThan(1);
  const [lastPosition, lastCount] = shortReads.history.at(-1)!;
  expect(lastPosition).toBeLessThan(Buffer.byteLength(header));
  expect(lastPosition! + lastCount).toBeGreaterThanOrEqual(Buffer.byteLength(header));
  expect(cursor!.remainingBytes()).toBe(0);
});

test("C-STATE-15 accepts a header whose newline is at the byte limit", () => {
  const { path } = createRollout(`${header.trimEnd().padEnd(256 * 1024 - 1)}\n`);
  const cursor = seedCodexResumeCursor(path, nativeSessionId)!;
  expect(cursor.readLiveChunk()).toEqual({ text: "", canContinueNow: false });
  const appended = '{"type":"new"}\n';
  appendFileSync(path, appended);
  expect(cursor.readLiveChunk()).toEqual({ text: appended, canContinueNow: false });
});

test.each([
  ["malformed header", "{\n"],
  ["EOF before header newline", header.trimEnd()],
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
