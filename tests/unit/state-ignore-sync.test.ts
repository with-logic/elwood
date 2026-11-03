/** Reuse successful ignore durability work without caching validation (PRD §8.1). */
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { syncIgnoreDirectory } from "../../src/state/preparation/ignore-sync.ts";
import { tempDir } from "../helpers/tmp.ts";

const sync = vi.hoisted(() => ({ count: 0, action: undefined as (() => void) | undefined }));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    fsyncSync: (fd: number) => {
      sync.count++;
      actual.fsyncSync(fd);
      sync.action?.();
    },
  };
});
afterEach(() => Object.assign(sync, { count: 0, action: undefined }));

function ignore(): string {
  const path = join(tempDir("elwood-ignore-sync-"), ".gitignore");
  fs.writeFileSync(path, "*\n");
  return path;
}

function accept(path: string): void {
  syncIgnoreDirectory(path, fs.lstatSync(path));
}

test("C-STATE-11 an unchanged ignore and parent sync only on first observation", () => {
  const path = ignore();
  accept(path);
  accept(path);
  accept(path);
  expect(sync.count).toBe(1);
  fs.writeFileSync(path, "# changed\n");
  accept(path);
  expect(sync.count).toBe(2);
  fs.chmodSync(path, 0o600);
  accept(path);
  expect(sync.count).toBe(3);
});

test("C-STATE-11 changed parent metadata syncs again and then settles", () => {
  const path = ignore();
  accept(path);
  fs.writeFileSync(join(dirname(path), "another-entry"), "");
  accept(path);
  accept(path);
  expect(sync.count).toBe(2);
});

test("C-STATE-11 replacing a parent requires sync even for the same ignore inode", () => {
  const root = tempDir("elwood-ignore-parent-");
  const parent = join(root, "state");
  fs.mkdirSync(parent);
  const path = join(parent, ".gitignore");
  fs.writeFileSync(path, "*\n");
  const original = fs.lstatSync(path);
  accept(path);
  fs.renameSync(parent, join(root, "previous"));
  fs.mkdirSync(parent);
  fs.linkSync(join(root, "previous", ".gitignore"), path);
  syncIgnoreDirectory(path, original);
  expect(sync.count).toBe(2);
});

test("C-STATE-11 path aliases have separate bounded observations", () => {
  const path = ignore();
  const alias = join(tempDir("elwood-ignore-alias-"), "state");
  fs.symlinkSync(dirname(path), alias, "dir");
  accept(path);
  accept(join(alias, ".gitignore"));
  accept(join(alias, ".gitignore"));
  expect(sync.count).toBe(2);
});

test("C-STATE-11 failed syncs are retried without caching success", () => {
  const path = ignore();
  sync.action = () => {
    throw Object.assign(new Error("fsync"), { code: "EIO" });
  };
  expect(() => accept(path)).toThrow("fsync");
  sync.action = undefined;
  accept(path);
  accept(path);
  expect(sync.count).toBe(2);
});

test("C-STATE-11 parent mutation during a sync is not retained", () => {
  const path = ignore();
  sync.action = () => fs.writeFileSync(join(dirname(path), "during-sync"), "");
  accept(path);
  sync.action = undefined;
  accept(path);
  accept(path);
  expect(sync.count).toBe(2);
});

test("C-STATE-11 parent stat failures cannot preserve an earlier success", () => {
  const path = ignore();
  const parent = dirname(path);
  const moved = `${parent}-moved`;
  accept(path);
  fs.renameSync(parent, moved);
  try {
    expect(() => syncIgnoreDirectory(path, fs.lstatSync(join(moved, ".gitignore")))).toThrow();
  } finally {
    fs.renameSync(moved, parent);
  }
  accept(path);
  expect(sync.count).toBe(2);
});

test("C-STATE-11 only the 32 most recent successful observations are retained", () => {
  const paths = Array.from({ length: 33 }, ignore);
  for (const path of paths) accept(path);
  expect(sync.count).toBe(33);
  const oldest = paths[0];
  const newest = paths[32];
  if (oldest === undefined || newest === undefined) throw new Error("fixture paths");
  accept(newest);
  expect(sync.count).toBe(33);
  accept(oldest);
  expect(sync.count).toBe(34);
});
