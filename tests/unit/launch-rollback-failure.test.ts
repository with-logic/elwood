/** A rollback I/O failure cannot prevent independent sibling restoration (C-API-20). */
import { existsSync, fstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { reserveLaunchOwnership } from "../../src/state/launch-ownership.ts";
import { tempDir } from "../helpers/tmp.ts";

const failure = vi.hoisted(() => ({ path: "", directoryFsync: false }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    fsyncSync: (fd: number) => {
      if (failure.directoryFsync && fstatSync(fd).isDirectory())
        throw new Error("directory fsync denied");
      actual.fsyncSync(fd);
    },
    renameSync: (from: string, to: string) => {
      if (to === failure.path) throw new Error("restore denied");
      actual.renameSync(from, to);
    },
  };
});
afterEach(() => {
  failure.path = "";
  failure.directoryFsync = false;
});

test("C-API-20 rollback attempts siblings after a failed restoration", () => {
  const path = tempDir();
  const first = join(path, "first");
  const second = join(path, "second");
  const prior = reserveLaunchOwnership(path);
  prior.commit();
  prior.publishFile(first, "old first");
  prior.publishFile(second, "old second");
  const pending = reserveLaunchOwnership(path);
  pending.publishFile(first, "pending first");
  pending.publishFile(second, "pending second");
  try {
    failure.path = first;
    expect(() => pending.rollback()).toThrowError(
      expect.objectContaining({ code: "state_corrupt" }),
    );
    expect(readFileSync(second, "utf8")).toBe("old second");
    expect(prior.current()).toBe(true);
    expect(pending.canPersist()).toBe(false);
    failure.path = "";
    pending.rollback();
    expect(readFileSync(first, "utf8")).toBe("old first");
  } finally {
    failure.path = "";
    pending.rollback();
    prior.release();
  }
});

test("C-API-20 a failed rollback settles and retries post-unlink durability", async () => {
  const path = tempDir();
  const file = join(path, "new");
  const prior = reserveLaunchOwnership(path);
  prior.commit();
  const pending = reserveLaunchOwnership(path);
  pending.publishFile(file, "pending");
  try {
    failure.directoryFsync = true;
    expect(() => pending.rollback()).toThrowError(
      expect.objectContaining({ code: "state_corrupt" }),
    );
    expect(pending.current()).toBe(false);
    expect(prior.current()).toBe(true);
    expect(pending.canPersist()).toBe(false);
    expect(existsSync(file)).toBe(false);
    await pending.waitForCleanup();
    failure.directoryFsync = false;
    expect(() => pending.rollback()).not.toThrow();
  } finally {
    failure.directoryFsync = false;
    pending.rollback();
    prior.release();
  }
});

test("C-API-20 rollback retry cannot replace the same bytes adopted by a newer owner", () => {
  const path = tempDir();
  const file = join(path, "shared");
  const prior = reserveLaunchOwnership(path);
  prior.commit();
  prior.publishFile(file, "prior");
  const pending = reserveLaunchOwnership(path);
  pending.publishFile(file, "pending");
  failure.path = file;
  expect(() => pending.rollback()).toThrow();
  failure.path = "";
  const successor = reserveLaunchOwnership(path);
  try {
    successor.commit();
    successor.publishFile(file, "pending");
    pending.rollback();
    expect(readFileSync(file, "utf8")).toBe("pending");
  } finally {
    successor.release();
  }
});

test("C-API-20 sibling rollback failure releases predecessor cleanup waiters", async () => {
  const path = tempDir();
  const file = join(path, "shared");
  const prior = reserveLaunchOwnership(path);
  prior.commit();
  prior.publishFile(file, "prior");
  const pending = reserveLaunchOwnership(path);
  pending.publishFile(file, "pending");
  let settled = false;
  const cleanup = prior.waitForCleanup().then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  try {
    failure.path = file;
    expect(() => pending.rollback()).toThrow();
    await cleanup;
    expect(settled).toBe(true);
    expect(prior.current()).toBe(true);
  } finally {
    failure.path = "";
    pending.rollback();
    prior.release();
  }
});
