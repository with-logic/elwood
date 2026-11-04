/** Internal probe-cache boundary identity checks and their limits (PRD §9.2). */
import { mkdirSync, renameSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { expect, expectTypeOf, test, vi } from "vitest";
import {
  createDirectoryProbeCache,
  type DirectoryProbeCache,
  type DirectoryRead,
  readInDirectory,
} from "../../src/runtime/probe/directory-key.ts";
import type { ProbeCache } from "../../src/runtime/probe-cache.ts";
import type { CommandOptions } from "../../src/runtime/seams.ts";
import { tempDir } from "../helpers/tmp.ts";

function lookup() {
  const cache = createDirectoryProbeCache<number>(3);
  const read = vi.fn<() => Promise<number>>();
  let next = 0;
  read.mockImplementation(() => Promise.resolve(++next));
  return { read, at: (cwd: string) => readInDirectory(cache, cwd, read) };
}

test("internal cache readers share one directory, but distinct paths and symlink aliases keep separate answers", async () => {
  const one = tempDir("elwood-directory-one-");
  const two = tempDir("elwood-directory-two-");
  const alias = join(tempDir("elwood-directory-alias-"), "link");
  symlinkSync(one, alias);
  const { at, read } = lookup();
  expect(await Promise.all([at(one), at(one)])).toEqual([1, 1]);
  expect(await at(two)).toBe(2);
  expect(await at(alias)).toBe(3);
  expect(await at(one)).toBe(1);
  expect(read).toHaveBeenCalledTimes(3);
});

test("internal cache separates replacement directories and recovers a restored original's answer", async () => {
  const root = tempDir("elwood-directory-replaced-");
  const cwd = join(root, "cwd");
  const original = join(root, "original");
  mkdirSync(cwd);
  const { at, read } = lookup();
  expect(await at(cwd)).toBe(1);
  renameSync(cwd, original);
  mkdirSync(cwd);
  expect(await at(cwd)).toBe(2);
  renameSync(cwd, join(root, "replacement"));
  renameSync(original, cwd);
  expect(await at(cwd)).toBe(1);
  expect(read).toHaveBeenCalledTimes(2);
});

test("internal cache refuses retention when the final boundary observes a replacement", async () => {
  const root = tempDir("elwood-directory-in-flight-");
  const cwd = join(root, "cwd");
  const original = join(root, "original");
  mkdirSync(cwd);
  const { at, read } = lookup();
  read.mockImplementationOnce(() => {
    renameSync(cwd, original);
    mkdirSync(cwd);
    return Promise.resolve(99);
  });
  expect(await at(cwd)).toBe(99);
  renameSync(cwd, join(root, "replacement"));
  renameSync(original, cwd);
  expect(await at(cwd)).toBe(1);
  expect(await at(cwd)).toBe(1);
  expect(read).toHaveBeenCalledTimes(2);
});

test("internal cache neither shares nor retains reads without a directory identity", async () => {
  const missing = join(tempDir("elwood-directory-missing-"), "missing");
  const { at, read } = lookup();
  expect(await Promise.all([at(missing), at(missing)])).toEqual(expect.arrayContaining([1, 2]));
  expect(await at(missing)).toBe(3);
  expect(read).toHaveBeenCalledTimes(3);
});

test("C-LIFE-11 a rejected directory read preserves its cause and is retried", async () => {
  const cwd = tempDir("elwood-directory-rejected-");
  const { at, read } = lookup();
  const failure = new Error("probe failed");
  read.mockRejectedValueOnce(failure);
  await expect(at(cwd)).rejects.toBe(failure);
  expect(await at(cwd)).toBe(1);
  expect(read).toHaveBeenCalledTimes(2);
});

test("internal cache enforces boundary admission while allowing stricter value admission", async () => {
  expectTypeOf<ProbeCache<DirectoryRead<number>>>().not.toExtend<DirectoryProbeCache<number>>();
  const cwd = tempDir("elwood-directory-admission-");
  const cache = createDirectoryProbeCache<number>(3, (value) => value > 0);
  const read = vi.fn<() => Promise<number>>().mockResolvedValueOnce(0).mockResolvedValue(1);
  const at = () => readInDirectory(cache, cwd, read);
  expect(await at()).toBe(0);
  expect(await at()).toBe(1);
  expect(await at()).toBe(1);
  expect(read).toHaveBeenCalledTimes(2);
});

test("internal cache cannot detect a directory swapped and restored between its boundary checks", async () => {
  const root = tempDir("elwood-directory-restored-between-checks-");
  const cwd = join(root, "cwd");
  const original = join(root, "original");
  mkdirSync(cwd);
  const { at, read } = lookup();
  read.mockImplementationOnce(() => {
    renameSync(cwd, original);
    mkdirSync(cwd);
    renameSync(cwd, join(root, "replacement"));
    renameSync(original, cwd);
    return Promise.resolve(99);
  });
  expect(await at(cwd)).toBe(99);
  expect(await at(cwd)).toBe(99);
  expect(read).toHaveBeenCalledTimes(1);
});

test("C-PERF-02 a missing pinned directory retains its original identity without cache admission", async () => {
  const root = tempDir("elwood-directory-pinned-missing-");
  const cwd = join(root, "cwd");
  mkdirSync(cwd);
  const identity = statSync(cwd, { bigint: true });
  renameSync(cwd, join(root, "original"));
  const cache = createDirectoryProbeCache<number>(3);
  const read = vi.fn(async () => 1);
  await readInDirectory(cache, cwd, read, identity);
  await readInDirectory(cache, cwd, read, identity);
  expect(read).toHaveBeenCalledTimes(2);
  expect(read).toHaveBeenLastCalledWith({ cwd, directoryIdentity: identity });
});

test("C-PERF-02 a directory missing at the final boundary is not retained after restoration", async () => {
  const root = tempDir("elwood-directory-final-missing-");
  const cwd = join(root, "cwd");
  const original = join(root, "original");
  mkdirSync(cwd);
  const { at, read } = lookup();
  read.mockImplementationOnce(() => {
    renameSync(cwd, original);
    return Promise.resolve(99);
  });
  expect(await at(cwd)).toBe(99);
  renameSync(original, cwd);
  expect(await at(cwd)).toBe(1);
  expect(read).toHaveBeenCalledTimes(2);
});

test("C-PERF-02 an original identity bypasses a replacement's settled answer", async () => {
  const root = tempDir("elwood-directory-pinned-replacement-");
  const cwd = join(root, "cwd");
  mkdirSync(cwd);
  const identity = statSync(cwd, { bigint: true });
  renameSync(cwd, join(root, "original"));
  mkdirSync(cwd);
  const cache = createDirectoryProbeCache<number>(3);
  const refusal = new Error("original directory refused");
  const read = vi.fn((options?: CommandOptions) =>
    options?.directoryIdentity?.ino === identity.ino ? Promise.reject(refusal) : Promise.resolve(1),
  );
  expect(await readInDirectory(cache, cwd, read)).toBe(1);
  await expect(readInDirectory(cache, cwd, read, identity)).rejects.toBe(refusal);
  expect(read).toHaveBeenCalledTimes(2);
  expect(read).toHaveBeenLastCalledWith({ cwd, directoryIdentity: identity });
});
