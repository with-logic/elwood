/** One failed setup cannot revoke a complete ignore another setup accepted (PRD §8.1, C-STATE-11). */
import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { prepareStateDir } from "../../src/state/store.ts";
import { tempDir } from "../helpers/tmp.ts";

const fault = vi.hoisted(
  (): {
    onDirectorySync: (() => void) | undefined;
    onWrite: (() => void) | undefined;
    onPublished: (() => void) | undefined;
  } => ({ onDirectorySync: undefined, onWrite: undefined, onPublished: undefined }),
);
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    linkSync: (source: string, destination: string) => {
      const linked = actual.linkSync(source, destination);
      const callback = fault.onPublished;
      fault.onPublished = undefined;
      callback?.();
      return linked;
    },
    fsyncSync: (fd: number) => {
      const callback = actual.fstatSync(fd).isDirectory() ? fault.onDirectorySync : undefined;
      if (callback !== undefined) {
        fault.onDirectorySync = undefined;
        callback();
        throw Object.assign(new Error("directory sync"), { code: "EIO" });
      }
      return actual.fsyncSync(fd);
    },
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      const callback = fault.onWrite;
      if (callback !== undefined) {
        fault.onWrite = undefined;
        actual.writeFileSync(args[0], "*");
        callback();
        throw Object.assign(new Error("partial write"), { code: "EIO" });
      }
      return actual.writeFileSync(...args);
    },
  };
});
afterEach(() =>
  Object.assign(fault, { onDirectorySync: undefined, onWrite: undefined, onPublished: undefined }),
);

test.each([
  "onDirectorySync",
  "onWrite",
] as const)("C-STATE-11 a publisher's %s failure preserves the other setup", (at) => {
  const cwd = tempDir("elwood-ignore-two-setups-");
  const stateDir = join(cwd, ".elwood");
  let accepted = false;
  fault[at] = () => {
    prepareStateDir(stateDir, { cwd, isImplicitDefaultStateDir: true, elwoodSessionId: "b" });
    accepted = true;
  };
  expect(() =>
    prepareStateDir(stateDir, { cwd, isImplicitDefaultStateDir: true, elwoodSessionId: "a" }),
  ).toThrow(expect.objectContaining({ code: "EIO" }));
  expect(accepted).toBe(true);
  expect(fs.existsSync(join(stateDir, "sessions", "b"))).toBe(true);
  expect(fs.readFileSync(join(stateDir, ".gitignore"), "utf8")).toBe("*\n");
  expect(fs.readdirSync(stateDir).sort()).toEqual([".gitignore", "sessions"]);
});

test("C-STATE-11 accepting an existing ignore must establish directory durability", () => {
  const cwd = tempDir("elwood-ignore-existing-sync-");
  const stateDir = join(cwd, ".elwood");
  fs.mkdirSync(stateDir);
  fs.writeFileSync(join(stateDir, ".gitignore"), "keep");
  fault.onDirectorySync = () => undefined;
  expect(() => prepareStateDir(stateDir, { cwd, isImplicitDefaultStateDir: true })).toThrow(
    "directory sync",
  );
  expect(fs.readFileSync(join(stateDir, ".gitignore"), "utf8")).toBe("keep");
  expect(fs.existsSync(join(stateDir, "sessions"))).toBe(false);
});

test("C-STATE-11 a second setup accepts a complete ignore before staging is unlinked", () => {
  const cwd = tempDir("elwood-ignore-linked-publication-");
  const stateDir = join(cwd, ".elwood");
  fault.onPublished = () => {
    expect(fs.lstatSync(join(stateDir, ".gitignore")).nlink).toBe(2);
    prepareStateDir(stateDir, { cwd, isImplicitDefaultStateDir: true, elwoodSessionId: "b" });
  };
  prepareStateDir(stateDir, { cwd, isImplicitDefaultStateDir: true, elwoodSessionId: "a" });
  expect(fs.readdirSync(join(stateDir, "sessions")).sort()).toEqual(["a", "b"]);
  expect(fs.readFileSync(join(stateDir, ".gitignore"), "utf8")).toBe("*\n");
});
