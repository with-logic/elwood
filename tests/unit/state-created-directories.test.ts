/** Creation snapshots and rollback never claim a changed or unverifiable directory (C-STATE-14). */
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { makeStateDirectory, prepareStateDirectory } from "../../src/state/directories.ts";
import { CreatedStateDirectories } from "../../src/state/preparation/created-directories.ts";
import { tempDir } from "../helpers/tmp.ts";

const fault = vi.hoisted(() => ({
  path: "",
  field: undefined as "dev" | "uid" | undefined,
  unreadable: false,
  mkdirFailure: "",
  removals: [] as string[],
  errors: new Map<string, string>(),
}));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
      const path = String(args[0]);
      if (path === fault.path && fault.unreadable)
        throw Object.assign(new Error("unreadable"), { code: "EACCES" });
      const info = actual.lstatSync(...args);
      return info === undefined || path !== fault.path || fault.field === undefined
        ? info
        : new Proxy(info, {
            get: (target, key) =>
              key === fault.field
                ? BigInt(Reflect.get(target, key)) + 1n
                : Reflect.get(target, key),
          });
    },
    mkdirSync: (...args: Parameters<typeof actual.mkdirSync>) => {
      if (String(args[0]) === fault.mkdirFailure && actual.existsSync(dirname(fault.mkdirFailure)))
        throw Object.assign(new Error("creation refused"), { code: "EACCES" });
      return actual.mkdirSync(...args);
    },
    rmdirSync: (path: fs.PathLike) => {
      fault.removals.push(String(path));
      const code = fault.errors.get(String(path));
      if (code !== undefined) throw Object.assign(new Error("removal refused"), { code });
      return actual.rmdirSync(path);
    },
  };
});
afterEach(() =>
  Object.assign(fault, {
    path: "",
    field: undefined,
    unreadable: false,
    mkdirFailure: "",
    removals: [],
    errors: new Map(),
  }),
);

function fixture() {
  const path = join(tempDir("elwood-owned-directories-"), "made");
  fs.mkdirSync(path);
  return { path, made: new CreatedStateDirectories() };
}

test.each([
  "file",
  "foreign",
] as const)("C-STATE-14 a %s replacement before the creation snapshot is not recorded", (kind) => {
  const { path, made } = fixture();
  if (kind === "file") {
    fs.rmdirSync(path);
    fs.writeFileSync(path, "keep");
  } else Object.assign(fault, { path, field: "uid" });
  made.record(path);
  expect(made.remove()).toBeUndefined();
  expect(fs.existsSync(path)).toBe(true);
});

test.each([
  "dev",
  "uid",
] as const)("C-STATE-14 changed %s ownership evidence prevents removal", (field) => {
  const { path, made } = fixture();
  made.record(path);
  Object.assign(fault, { path, field });
  expect(made.remove()).toBeUndefined();
  expect(fault.removals).toEqual([]);
});

test("C-STATE-14 an unverifiable identity is preserved and reports the cleanup error", () => {
  const { path, made } = fixture();
  made.record(path);
  Object.assign(fault, { path, unreadable: true });
  expect(made.remove()).toBe("EACCES");
  expect(fault.removals).toEqual([]);
});

test("C-STATE-14 retained shared entries survive and ordinary owned entries are removed", () => {
  const { path, made } = fixture();
  made.record(path);
  expect(made.remove(new Set([path]))).toBeUndefined();
  expect(fs.existsSync(path)).toBe(true);
  expect(made.remove()).toBeUndefined();
  expect(fs.existsSync(path)).toBe(false);
  expect(made.remove()).toBeUndefined();
});

test("C-STATE-14 nonempty owned directories survive without a cleanup error", () => {
  const { path, made } = fixture();
  made.record(path);
  fs.writeFileSync(join(path, "keep"), "user data");
  expect(made.remove()).toBeUndefined();
  expect(fs.readFileSync(join(path, "keep"), "utf8")).toBe("user data");
});

test("C-STATE-14 cleanup attempts every entry and preserves the first failure", () => {
  const { path, made } = fixture();
  const child = join(path, "child");
  fs.mkdirSync(child);
  made.record(path);
  made.record(child);
  fault.errors.set(child, "EPERM");
  fault.errors.set(path, "EIO");
  expect(made.remove()).toBe("EPERM");
  expect(fault.removals).toEqual([child, path]);
});

test.each([
  false,
  true,
])("C-STATE-14 mkdir failure preserves existing parents and records partial creation (%s)", (existing) => {
  const root = tempDir("elwood-partial-creation-");
  const parent = join(root, "parent");
  const child = join(parent, "child");
  const made = new CreatedStateDirectories();
  if (existing) fs.mkdirSync(parent);
  fault.mkdirFailure = child;
  expect(() => makeStateDirectory(child, 0o700, "with-parents", made.record)).toThrow(
    "creation refused",
  );
  expect(fs.existsSync(parent)).toBe(true);
  expect(made.remove()).toBeUndefined();
  expect(fs.existsSync(parent)).toBe(existing);
});

test("C-STATE-14 validating and chmodding an existing directory never claims its creation", () => {
  const { path, made } = fixture();
  fs.chmodSync(path, 0o755);
  prepareStateDirectory(path, 0o700, "inside-parent", made.record);
  expect(fs.statSync(path).mode & 0o777).toBe(0o700);
  expect(made.remove()).toBeUndefined();
  expect(fs.existsSync(path)).toBe(true);
});
