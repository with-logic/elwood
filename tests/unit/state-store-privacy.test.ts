/**
 * Session-record reads never follow links or trust shared metadata (PRD §8.2,
 * C-STATE-04): a planted symlink, a group/world-readable record, a record owned by
 * another user, or a non-regular file is `state_corrupt`, never resumed from.
 */

import { chmodSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ElwoodError } from "../../src/core/errors.ts";
import { readPrivateFile } from "../../src/state/private-read.ts";
import {
  createSessionRecord,
  prepareStateDir,
  readSessionRecord,
  sessionDir,
  writeSessionRecord,
} from "../../src/state/store.ts";
import { tempDir } from "../helpers/tmp.ts";

function fixture(id: string) {
  const root = tempDir("elwood-privacy-");
  prepareStateDir(root);
  const record = createSessionRecord({ cwd: root, id });
  const dir = sessionDir(root, id);
  writeSessionRecord(record, dir);
  return { root, record, path: join(dir, "session.json") };
}

function errorOf(callback: () => unknown): ElwoodError {
  try {
    callback();
  } catch (error) {
    if (error instanceof ElwoodError) return error;
    throw error;
  }
  throw new Error("Expected ElwoodError");
}

describe("readSessionRecord privacy", () => {
  test("reads a private, owner-matched regular record", () => {
    const saved = fixture("ok");
    expect(readSessionRecord(saved.root, "ok")).toEqual(saved.record);
  });

  test("rejects a symlinked record instead of following it", () => {
    const linked = fixture("linked");
    const target = join(linked.root, "target.json");
    writeFileSync(target, JSON.stringify(linked.record), { mode: 0o600 });
    unlinkSync(linked.path);
    symlinkSync(target, linked.path);
    expect(errorOf(() => readSessionRecord(linked.root, "linked")).code).toBe("state_corrupt");
  });

  test("rejects a group/world-readable record", () => {
    const shared = fixture("shared");
    chmodSync(shared.path, 0o644);
    const error = errorOf(() => readSessionRecord(shared.root, "shared"));
    expect(error.code).toBe("state_corrupt");
    expect(error.details["cause"]).toBe("group or world accessible");
  });

  test("rejects a record owned by another user or an unverifiable owner", () => {
    const owned = fixture("owned");
    const foreign = errorOf(() => readSessionRecord(owned.root, "owned", { uid: -1 }));
    expect(foreign.details["cause"]).toBe("not owned by the current user");
    // No verifiable uid (a platform without getuid) is never trusted as private.
    const corrupt = (reason: string) => new Error(reason);
    expect(() => readPrivateFile(owned.path, undefined, corrupt)).toThrow(
      "file owner cannot be verified",
    );
  });

  test("rejects a directory where the record should be", () => {
    const directory = fixture("directory");
    unlinkSync(directory.path);
    mkdirSync(directory.path, { mode: 0o700 });
    expect(errorOf(() => readSessionRecord(directory.root, "directory")).details["cause"]).toBe(
      "not a regular file",
    );
  });

  test("readPrivateFile reports absence as undefined and other faults through corrupt()", () => {
    const root = tempDir("elwood-private-read-");
    const corrupt = (reason: string) => new Error(reason);
    expect(readPrivateFile(join(root, "missing"), { uid: 0 }, corrupt)).toBeUndefined();
    const dangling = join(root, "dangling");
    symlinkSync(join(root, "nowhere"), dangling);
    expect(() => readPrivateFile(dangling, { uid: 0 }, corrupt)).toThrow(/ELOOP|ENOENT/);
  });
});
