/** Closing staging files preserves primary installation failures (PRD §8.1, C-ERR-08). */
import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { installDefaultIgnore } from "../../src/state/preparation/install-ignore.ts";
import { tempDir } from "../helpers/tmp.ts";

const fault = vi.hoisted(() => ({ fd: -1, write: false, cleanup: false, noCode: false }));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const fd = actual.openSync(...args);
      if (String(args[0]).endsWith(".pending")) fault.fd = fd;
      return fd;
    },
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (fault.write) throw Object.assign(new Error("write"), { code: "EIO" });
      return actual.writeFileSync(...args);
    },
    unlinkSync: (path: string) => {
      if (fault.cleanup) throw Object.assign(new Error("unlink"), { code: "EPERM" });
      return actual.unlinkSync(path);
    },
    closeSync: (fd: number) => {
      actual.closeSync(fd);
      if (fd === fault.fd) {
        if (fault.noCode) throw new Error("close without code");
        throw Object.assign(new Error("close"), { code: "EACCES" });
      }
    },
  };
});
afterEach(() => Object.assign(fault, { fd: -1, write: false, cleanup: false, noCode: false }));

test("C-ERR-08 a lone close error is reported and retains the complete ignore", () => {
  const path = join(tempDir("elwood-ignore-close-"), ".gitignore");
  expect(() => installDefaultIgnore(path)).toThrow(expect.objectContaining({ code: "EACCES" }));
  expect(fs.readFileSync(path, "utf8")).toBe("*\n");
});

test.each([
  false,
  true,
])("C-ERR-08 write failure retains the first cleanup code (%s)", (cleanup) => {
  fault.write = true;
  fault.cleanup = cleanup;
  const path = join(tempDir("elwood-ignore-double-"), ".gitignore");
  expect(() => installDefaultIgnore(path)).toThrow(
    expect.objectContaining({
      message: "write",
      code: "EIO",
      cleanupErrorCode: cleanup ? "EPERM" : "EACCES",
    }),
  );
  expect(fs.existsSync(path)).toBe(false);
});

test("C-ERR-08 an uncoded close failure cannot replace the primary failure", () => {
  fault.write = true;
  fault.noCode = true;
  const path = join(tempDir("elwood-ignore-close-unknown-"), ".gitignore");
  expect(() => installDefaultIgnore(path)).toThrow(
    expect.objectContaining({ message: "write", code: "EIO" }),
  );
});
