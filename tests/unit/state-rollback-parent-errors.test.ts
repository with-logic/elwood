/** Parent trust failures preserve native cleanup diagnostics (PRD §8.1, C-STATE-14). */
import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { CreatedStateDirectories } from "../../src/state/preparation/created-directories.ts";
import { trustedRollbackParent } from "../../src/state/preparation/rollback-parent.ts";
import { tempDir } from "../helpers/tmp.ts";

const fault = vi.hoisted(() => ({ path: "", error: undefined as unknown }));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
      if (String(args[0]) === fault.path) throw fault.error;
      return actual.lstatSync(...args);
    },
  };
});
afterEach(() => Object.assign(fault, { path: "", error: undefined }));

test.each([
  "EACCES",
  "EIO",
  undefined,
])("C-STATE-14 parent read failure %s retains its cause", (code) => {
  const parent = fs.realpathSync(tempDir("elwood-rollback-parent-error-"));
  const path = join(parent, "created");
  fs.mkdirSync(path);
  const made = new CreatedStateDirectories();
  made.record(path);
  const error = Object.assign(new Error("parent read failed"), { code });
  Object.assign(fault, { path: parent, error });
  expect(() => trustedRollbackParent(path)).toThrow(error);
  if (code !== undefined) expect(made.remove()).toBe(code);
  expect(fs.existsSync(path)).toBe(true);
});

test("C-STATE-14 a missing parent skips removal without a new cleanup error", () => {
  const parent = tempDir("elwood-rollback-parent-missing-");
  fs.rmdirSync(parent);
  expect(trustedRollbackParent(join(parent, "created"))).toBe(false);
});
