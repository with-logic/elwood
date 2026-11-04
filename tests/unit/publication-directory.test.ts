/** Verified original-directory lookup and descriptor lifetime (PRD §8.1, C-API-61). */
import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { writePrivateFileAtomic } from "../../src/state/files.ts";
import { LaunchPublication } from "../../src/state/launch-publication.ts";
import { PublicationDirectory } from "../../src/state/publication-directory.ts";
import { tempDir } from "../helpers/tmp.ts";

const native = await vi.importActual<typeof import("node:fs")>("node:fs");
const fault = vi.hoisted(() => ({
  platform: "darwin",
  parent: "",
  moved: "",
  code: "",
  alias: "valid",
  opened: 0,
  failStat: false,
  foreign: false,
  held: -1,
  closes: [] as number[],
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
      if (args[0] === fault.parent && ++fault.opened === 2) fault.held = fd;
      return fd;
    },
    closeSync: (fd: number) => {
      fault.closes.push(fd);
      actual.closeSync(fd);
    },
    fstatSync: (...args: Parameters<typeof actual.fstatSync>) => {
      if (args[0] === fault.held && fault.failStat) throw new Error("fstat failed");
      const info = actual.fstatSync(...args);
      if (args[0] === fault.held && fault.foreign)
        info.uid = typeof info.uid === "bigint" ? info.uid + 1n : info.uid + 1;
      return info;
    },
    lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
      if (args[0] === fault.parent && fault.code === "uncoded") throw new Error("uncoded fault");
      if (args[0] === fault.parent && fault.code)
        throw Object.assign(new Error("lookup failed"), { code: fault.code });
      if (String(args[0]).startsWith("/.vol/")) {
        if (fault.alias === "missing")
          throw Object.assign(new Error("no volfs"), { code: "ENOENT" });
        const info = actual.lstatSync(fault.moved, { bigint: true });
        if (fault.alias === "different") info.ino += 1n;
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
    platform: "darwin",
    parent: "",
    moved: "",
    code: "",
    alias: "valid",
    opened: 0,
    failStat: false,
    foreign: false,
    held: -1,
  });
  fault.closes.length = 0;
});
function fixture() {
  fault.parent = join(tempDir(), "parent");
  fs.mkdirSync(fault.parent, { mode: 0o700 });
  fault.moved = `${fault.parent}-moved`;
  return join(fault.parent, "record");
}

test("C-API-61 an unchanged parent keeps the ordinary path and closes its pin", () => {
  const file = fixture();
  const pin = new PublicationDirectory(file);
  expect(pin.rollbackPath(file)).toBe(file);
  pin.close();
  expect(() => native.fstatSync(fault.held)).toThrowError(
    expect.objectContaining({ code: "EBADF" }),
  );
});

for (const code of ["ENOENT", "ENOTDIR", ""]) {
  test(`C-API-61 a moved parent uses only its verified inode namespace (${code || "replacement"})`, () => {
    const file = fixture();
    const pin = new PublicationDirectory(file);
    fs.renameSync(fault.parent, fault.moved);
    fs.mkdirSync(fault.parent);
    fault.code = code;
    try {
      expect(pin.rollbackPath(file)).toMatch(/^\/\.vol\/\d+\/\d+\/record$/);
    } finally {
      pin.close();
    }
  });
}

for (const alias of ["missing", "different", "foreign", "file"]) {
  test(`C-API-61 an unavailable or unverifiable inode namespace fails closed (${alias})`, () => {
    const file = fixture();
    const pin = new PublicationDirectory(file);
    fs.renameSync(fault.parent, fault.moved);
    fault.alias = alias;
    try {
      expect(() => pin.rollbackPath(file)).toThrow();
    } finally {
      pin.close();
    }
  });
}

test("C-API-61 ordinary lookup faults and unsupported platforms do not choose another directory", () => {
  const file = fixture();
  const pin = new PublicationDirectory(file);
  fault.code = "EACCES";
  try {
    expect(() => pin.rollbackPath(file)).toThrow("lookup failed");
    fault.code = "uncoded";
    expect(() => pin.rollbackPath(file)).toThrow("uncoded fault");
    fault.code = "ENOENT";
    fault.platform = "linux";
    expect(() => pin.rollbackPath(file)).toThrow("Could not locate");
  } finally {
    pin.close();
  }
});

for (const mode of ["failStat", "foreign"] as const) {
  test(`C-API-61 a failed pin verification releases the descriptor (${mode})`, () => {
    const file = fixture();
    fault[mode] = true;
    expect(() => new PublicationDirectory(file)).toThrow();
    expect(() => native.fstatSync(fault.held)).toThrowError(
      expect.objectContaining({ code: "EBADF" }),
    );
  });
}

for (const action of ["clear", "forget", "rollback"] as const) {
  test(`C-API-61 ${action} closes publication descriptors exactly once`, () => {
    const file = fixture();
    const publication = new LaunchPublication();
    publication.write(file, "pending");
    expect(native.fstatSync(fault.held).isDirectory()).toBe(true);
    if (action === "forget") {
      publication.forget(file);
      publication.forget(file);
    } else publication[action]();
    expect(() => native.fstatSync(fault.held)).toThrowError(
      expect.objectContaining({ code: "EBADF" }),
    );
    publication.clear();
  });
}

test("C-API-61 failed rollback keeps its descriptor for a successful retry", () => {
  const file = fixture();
  writePrivateFileAtomic(file, "prior");
  fault.opened = 0;
  const publication = new LaunchPublication();
  publication.write(file, "pending");
  fs.renameSync(fault.parent, fault.moved);
  fault.alias = "missing";
  expect(() => publication.rollback()).toThrowError(
    expect.objectContaining({ code: "state_corrupt" }),
  );
  expect(native.fstatSync(fault.held).isDirectory()).toBe(true);
  expect(fs.readFileSync(join(fault.moved, "record"), "utf8")).toBe("pending");
  fs.renameSync(fault.moved, fault.parent);
  fault.alias = "valid";
  publication.rollback();
  expect(fs.readFileSync(file, "utf8")).toBe("prior");
  expect(() => native.fstatSync(fault.held)).toThrowError(
    expect.objectContaining({ code: "EBADF" }),
  );
});
