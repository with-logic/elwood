/** Default state setup publishes complete ignores without clobbering files (PRD §8.1, C-STATE-11). */
import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { prepareStateDir } from "../../src/state/store.ts";
import { tempDir } from "../helpers/tmp.ts";

const fault = vi.hoisted(() => ({ destination: "", compete: false, failWrite: false }));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const path = String(args[0]);
      if (
        fault.compete &&
        (path === fault.destination || path.startsWith(`${fault.destination}.`))
      ) {
        fault.compete = false;
        actual.writeFileSync(fault.destination, "keep");
      }
      return actual.openSync(...args);
    },
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (fault.failWrite) {
        fault.failWrite = false;
        actual.writeFileSync(args[0], "*");
        throw Object.assign(new Error("partial write"), { code: "EIO" });
      }
      return actual.writeFileSync(...args);
    },
  };
});
afterEach(() => Object.assign(fault, { destination: "", compete: false, failWrite: false }));

test("C-STATE-11 setup preserves a competing default ignore writer", () => {
  const cwd = tempDir("elwood-ignore-compete-");
  const stateDir = join(cwd, ".elwood");
  fault.destination = join(stateDir, ".gitignore");
  fault.compete = true;
  prepareStateDir(stateDir, { cwd, isImplicitDefaultStateDir: true });
  expect(fault.compete).toBe(false);
  expect(fs.readFileSync(fault.destination, "utf8")).toBe("keep");
  expect(fs.readdirSync(stateDir).sort()).toEqual([".gitignore", "sessions"]);
});

test("C-STATE-11 setup can retry after a partial default ignore write", () => {
  const cwd = tempDir("elwood-ignore-partial-");
  const stateDir = join(cwd, ".elwood");
  fault.failWrite = true;
  expect(() => prepareStateDir(stateDir, { cwd, isImplicitDefaultStateDir: true })).toThrow(
    "partial write",
  );
  expect(fs.existsSync(join(stateDir, ".gitignore"))).toBe(false);
  prepareStateDir(stateDir, { cwd, isImplicitDefaultStateDir: true });
  expect(fs.readFileSync(join(stateDir, ".gitignore"), "utf8")).toBe("*\n");
});
