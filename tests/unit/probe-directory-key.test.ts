/** Directory-scoped probe-cache identity and replacement checks (PRD §9.2, C-PERF-02). */
import { mkdirSync, renameSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { type DirectoryRead, readInDirectory } from "../../src/runtime/probe/directory-key.ts";
import { createProbeCache } from "../../src/runtime/probe-cache.ts";
import { tempDir } from "../helpers/tmp.ts";

function lookup() {
  const cache = createProbeCache<DirectoryRead<number>>(3, (read) => read.sameDirectory);
  const read = vi.fn<() => Promise<number>>();
  let next = 0;
  read.mockImplementation(() => Promise.resolve(++next));
  return { read, at: (cwd: string) => readInDirectory(cache, cwd, read) };
}

test("C-PERF-02 readers share one directory, but distinct paths and symlink aliases keep separate answers", async () => {
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

test("C-PERF-02 replacing a directory misses its old answer, and restoring the original recovers that answer", async () => {
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

test("C-PERF-02 a read crossing directory replacement is delivered but cannot poison the original directory's cache", async () => {
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

test("C-PERF-02 an unidentifiable directory neither shares nor retains its reads", async () => {
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
