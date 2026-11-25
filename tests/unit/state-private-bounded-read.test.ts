/** Bounded private reads assemble short reads without accepting size changes (C-STATE-15). */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { reserveLaunchOwnership } from "../../src/state/launch-ownership.ts";
import { currentFileOwner, readPrivateFile } from "../../src/state/private-read.ts";
import { tempDirForUnit } from "./helpers.ts";

const boundary = vi.hoisted(() => ({ beforeRead: undefined as (() => void) | undefined }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const readSync = (
    fd: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => {
    boundary.beforeRead?.();
    return actual.readSync(fd, buffer, offset, Math.min(3, length), position);
  };
  return { ...actual, readSync };
});

afterEach(() => {
  boundary.beforeRead = undefined;
});

const content = "complete private metadata";
const file = () => {
  const path = join(tempDirForUnit(), "sidecar.json");
  writeFileSync(path, content, { mode: 0o600 });
  return path;
};
const read = (path: string) =>
  readPrivateFile(path, currentFileOwner(), (fault) => new Error(fault), 64);

test("C-STATE-15 a bounded private read collects all short reads", () => {
  expect(read(file())).toBe(content);
});

test("C-STATE-15 a file above the private byte limit is rejected before descriptor reads", () => {
  const path = file();
  writeFileSync(path, "x".repeat(65));
  const beforeRead = vi.fn();
  boundary.beforeRead = beforeRead;
  expect(() => read(path)).toThrowError("invalid bounded private file length");
  expect(beforeRead).not.toHaveBeenCalled();
});

test.each([
  { change: "shrink", updated: "small" },
  { change: "grow", updated: `${content} suffix` },
])("C-STATE-15 a bounded private read rejects a file that changes size ($change)", ({
  updated,
}) => {
  const path = file();
  boundary.beforeRead = () => {
    boundary.beforeRead = undefined;
    writeFileSync(path, updated);
  };
  expect(() => read(path)).toThrowError("invalid bounded private file length");
});

test("C-STATE-15 a bounded launch read does not borrow bytes across directory replacement", () => {
  const root = tempDirForUnit();
  const sessionDir = join(root, "session");
  const path = join(sessionDir, "sidecar.json");
  mkdirSync(sessionDir, { mode: 0o700 });
  writeFileSync(path, content, { mode: 0o600 });
  const ownership = reserveLaunchOwnership(sessionDir);
  ownership.publishFile(join(sessionDir, "session.json"), "published");
  try {
    boundary.beforeRead = () => {
      boundary.beforeRead = undefined;
      renameSync(sessionDir, join(root, "original"));
      mkdirSync(sessionDir, { mode: 0o700 });
      writeFileSync(path, "replacement", { mode: 0o600 });
    };
    const read = () => ownership.readFile(path, 64);
    if (process.platform === "darwin") expect(read()).toBe(content);
    else expect(read).toThrowError(expect.objectContaining({ code: "state_corrupt" }));
  } finally {
    ownership.release();
  }
});
