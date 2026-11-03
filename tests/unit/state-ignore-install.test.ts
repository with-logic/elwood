/** Default ignore installation never publishes partial contents after failure (PRD §8.1, C-STATE-11). */
import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  installDefaultIgnore,
  unlinkOwnedIgnore,
} from "../../src/state/preparation/install-ignore.ts";
import { tempDir } from "../helpers/tmp.ts";

const fault = vi.hoisted(() => ({
  at: "",
  staging: "",
  cleanup: false,
  unlinkOnce: false,
}));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  const fail = (at: string) => {
    if (fault.at === at) {
      fault.at = "";
      throw Object.assign(new Error(at), { code: "EIO" });
    }
  };
  return {
    ...actual,
    lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
      fail("lookup");
      return actual.lstatSync(...args);
    },
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      if (typeof args[1] === "number") fault.staging = String(args[0]);
      return actual.openSync(...args);
    },
    fstatSync: (...args: Parameters<typeof actual.fstatSync>) => {
      fail("stat");
      return actual.fstatSync(...args);
    },
    fsyncSync: (fd: number) => {
      fail(actual.fstatSync(fd).isDirectory() ? "sync-directory" : "sync-file");
      return actual.fsyncSync(fd);
    },
    fchmodSync: (...args: Parameters<typeof actual.fchmodSync>) => {
      fail("chmod");
      return actual.fchmodSync(...args);
    },
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (fault.at === "replace") {
        actual.renameSync(fault.staging, `${fault.staging}.kept`);
        actual.writeFileSync(fault.staging, "other writer");
        fault.at = "write";
      }
      if (fault.at === "cleanup") {
        fault.at = "write";
        fault.cleanup = true;
      }
      fail("write");
      return actual.writeFileSync(...args);
    },
    unlinkSync: (path: string) => {
      if (fault.unlinkOnce) {
        fault.unlinkOnce = false;
        throw Object.assign(new Error("after link"), { code: "EACCES" });
      }
      if (fault.cleanup) throw Object.assign(new Error("cleanup"), { code: "EACCES" });
      return actual.unlinkSync(path);
    },
    linkSync: (source: string, destination: string) => {
      if (fault.at === "vanished") {
        fault.at = "";
        throw Object.assign(new Error("vanished"), { code: "EEXIST" });
      }
      if (fault.at === "existing") {
        fault.at = "";
        actual.writeFileSync(destination, "keep");
      }
      fail("link");
      const linked = actual.linkSync(source, destination);
      if (fault.at === "after-link") {
        fault.at = "";
        fault.unlinkOnce = true;
      }
      return linked;
    },
  };
});
afterEach(() => {
  Object.assign(fault, {
    at: "",
    staging: "",
    cleanup: false,
    unlinkOnce: false,
  });
});

test.each([
  "lookup",
  "stat",
  "chmod",
  "write",
  "link",
  "sync-file",
  "vanished",
])("C-STATE-11 an installation %s failure leaves no partial default ignore and retry repairs it", (at) => {
  const root = tempDir("elwood-ignore-stage-");
  const path = join(root, ".gitignore");
  fault.at = at;
  expect(() => installDefaultIgnore(path)).toThrow(at);
  expect(fs.readdirSync(root)).toEqual([]);
  installDefaultIgnore(path);
  expect(fs.readFileSync(path, "utf8")).toBe("*\n");
});

test("C-STATE-11 failed staging cleanup preserves a replacement inode", () => {
  const root = tempDir("elwood-ignore-replaced-");
  fault.at = "replace";
  expect(() => installDefaultIgnore(join(root, ".gitignore"))).toThrow("write");
  expect(fs.readFileSync(fault.staging, "utf8")).toBe("other writer");
  expect(fs.existsSync(join(root, ".gitignore"))).toBe(false);
});

test("C-STATE-11 atomic installation preserves a competing writer's completed ignore", () => {
  const root = tempDir("elwood-ignore-link-");
  fault.at = "existing";
  expect(installDefaultIgnore(join(root, ".gitignore"))).toBeUndefined();
  expect(fs.readdirSync(root)).toEqual([".gitignore"]);
  expect(fs.readFileSync(join(root, ".gitignore"), "utf8")).toBe("keep");
});

test("C-STATE-11 a failed staging rollback preserves the primary error and reports cleanup", () => {
  const root = tempDir("elwood-ignore-cleanup-");
  fault.at = "cleanup";
  expect(() => installDefaultIgnore(join(root, ".gitignore"))).toThrow(
    expect.objectContaining({ message: "write", code: "EIO", cleanupErrorCode: "EACCES" }),
  );
  expect(fs.existsSync(join(root, ".gitignore"))).toBe(false);
});

test("C-STATE-11 a post-install failure retains the complete shared ignore", () => {
  const root = tempDir("elwood-ignore-after-link-");
  fault.at = "after-link";
  expect(() => installDefaultIgnore(join(root, ".gitignore"))).toThrow(
    expect.objectContaining({ message: "after link", code: "EACCES" }),
  );
  expect(fs.readdirSync(root)).toEqual([".gitignore"]);
  expect(fs.readFileSync(join(root, ".gitignore"), "utf8")).toBe("*\n");
});

test("C-STATE-11 removing an already absent ignore path is harmless", () => {
  const root = tempDir("elwood-ignore-absent-");
  const path = join(root, ".gitignore");
  const owned = installDefaultIgnore(path);
  expect(owned).toBeDefined();
  if (owned === undefined) throw new Error("ignore was not installed");
  fs.unlinkSync(path);
  expect(() => unlinkOwnedIgnore(path, owned)).not.toThrow();
});

test("C-STATE-11 installation leaves an existing ignore unchanged", () => {
  const root = tempDir("elwood-ignore-existing-");
  const path = join(root, ".gitignore");
  fs.writeFileSync(path, "keep");
  expect(installDefaultIgnore(path)).toBeUndefined();
  expect(fs.readFileSync(path, "utf8")).toBe("keep");
});
