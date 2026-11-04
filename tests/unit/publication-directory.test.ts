/** Verified original-directory lookup and descriptor lifetime (PRD §8.1, C-STATE-01). */
import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { PublicationDirectoryHold } from "../../src/state/publication-directory.ts";
import { tempDir } from "../helpers/tmp.ts";

const native = await vi.importActual<typeof import("node:fs")>("node:fs");
const rejectedAliases = ["missing", "different", "different-device", "foreign", "file"] as const;
type FaultAlias = "valid" | (typeof rejectedAliases)[number];
const fault = vi.hoisted(() => ({
  platform: process.platform,
  parent: "",
  moved: "",
  alias: "valid" as FaultAlias,
  opened: 0,
  failStat: false,
  afterValidation: false,
  checks: 0,
  foreign: false,
  held: -1,
  failCleanup: false,
}));
vi.mock("node:os", async (original) => ({
  ...(await original<typeof import("node:os")>()),
  platform: () => fault.platform,
}));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const fd = actual.openSync(...args);
      if (args[0] === fault.parent && ++fault.opened === 1) fault.held = fd;
      return fd;
    },
    closeSync: (fd: number) => {
      actual.closeSync(fd);
      if (fd === fault.held && fault.failCleanup) throw new Error("secondary close failure");
    },
    fstatSync: (...args: Parameters<typeof actual.fstatSync>) => {
      const fail = args[0] === fault.held && (!fault.afterValidation || ++fault.checks === 2);
      if (fail && fault.failStat) throw new Error("fstat failed");
      const info = actual.fstatSync(...args);
      if (fail && fault.foreign)
        info.uid = typeof info.uid === "bigint" ? info.uid + 1n : info.uid + 1;
      return info;
    },
    lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
      if (String(args[0]).startsWith("/.vol/")) {
        if (fault.alias === "missing") return actual.lstatSync("/.vol/0/0", { bigint: true });
        const info = actual.lstatSync(actual.existsSync(fault.moved) ? fault.moved : fault.parent, {
          bigint: true,
        });
        if (fault.alias === "different") info.ino += 1n;
        if (fault.alias === "different-device") info.dev += 1n;
        if (fault.alias === "foreign") info.uid += 1n;
        if (fault.alias === "file") info.isDirectory = () => false;
        return info;
      }
      return actual.lstatSync(...args);
    },
  };
});
afterEach(() => {
  Object.assign(fault, {
    platform: process.platform,
    parent: "",
    moved: "",
    alias: "valid",
    opened: 0,
    failStat: false,
    afterValidation: false,
    checks: 0,
    foreign: false,
    held: -1,
  });
  fault.failCleanup = false;
});
function fixture() {
  fault.parent = join(tempDir(), "parent");
  fs.mkdirSync(fault.parent, { mode: 0o700 });
  fault.moved = `${fault.parent}-moved`;
  return join(fault.parent, "record");
}

test("C-STATE-01 an unchanged parent keeps the ordinary path and closes its pin", () => {
  const file = fixture();
  fault.platform = "linux";
  const pin = new PublicationDirectoryHold(file);
  expect(fault.opened).toBe(1);
  expect(pin.pathInHeldDirectory(file)).toBe(file);
  pin.close();
  expect(() => native.fstatSync(fault.held)).toThrowError(
    expect.objectContaining({ code: "EBADF" }),
  );
});

for (const replace of [false, true]) {
  test(`C-STATE-01 a moved parent uses only its verified inode namespace (${replace ? "replacement" : "missing"})`, () => {
    const file = fixture();
    const pin = new PublicationDirectoryHold(file);
    fs.renameSync(fault.parent, fault.moved);
    if (replace) fs.mkdirSync(fault.parent);
    fault.platform = "darwin";
    try {
      expect(pin.pathInHeldDirectory(file)).toMatch(/^\/\.vol\/\d+\/\d+\/record$/);
    } finally {
      pin.close();
    }
  });
}

for (const alias of rejectedAliases) {
  test(`C-STATE-01 an unavailable or unverifiable inode namespace fails closed (${alias})`, () => {
    const file = fixture();
    const pin = new PublicationDirectoryHold(file);
    fs.renameSync(fault.parent, fault.moved);
    fault.alias = alias;
    fault.platform = "darwin";
    try {
      if (alias === "missing")
        expect(() => native.lstatSync("/.vol/0/0")).toThrowError(
          expect.objectContaining({ code: "ENOENT" }),
        );
      expect(() => pin.pathInHeldDirectory(file)).toThrowError(
        expect.objectContaining({
          code: "state_corrupt",
          message: "Could not locate the original launch state directory.",
          details: {},
        }),
      );
    } finally {
      pin.close();
    }
  });
}

test("C-STATE-01 unsupported platforms never choose a changed directory", () => {
  const file = fixture();
  const pin = new PublicationDirectoryHold(file);
  fs.renameSync(fault.parent, fault.moved);
  fs.mkdirSync(fault.parent);
  fault.platform = "linux";
  try {
    expect(() => pin.pathInHeldDirectory(file)).toThrowError(
      expect.objectContaining({ code: "state_corrupt" }),
    );
  } finally {
    pin.close();
  }
});

for (const [mode, snapshot] of [
  ["failStat", false],
  ["foreign", false],
  ["failStat", true],
  ["foreign", true],
] as const) {
  test(`C-STATE-01 a failed pin verification releases the descriptor (${mode})`, () => {
    const file = fixture();
    fault[mode] = true;
    fault.afterValidation = snapshot;
    fault.failCleanup = true;
    expect(() => new PublicationDirectoryHold(file)).toThrow(
      mode === "failStat" ? "fstat failed" : snapshot ? "Could not locate" : "must be owned",
    );
    expect(() => native.fstatSync(fault.held)).toThrowError(
      expect.objectContaining({ code: "EBADF" }),
    );
  });
}
