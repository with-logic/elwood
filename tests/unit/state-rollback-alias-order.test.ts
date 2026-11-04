/** Owned rollback follows creation ancestry across native aliases and retries (C-STATE-14). */
import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { CreatedStateDirectories } from "../../src/state/preparation/created-directories.ts";
import { prepareStateDir } from "../../src/state/store.ts";
import { tempDir } from "../helpers/tmp.ts";

const fault = vi.hoisted(() => ({
  cwd: "",
  sessions: "",
  sessionsMade: false,
  lateCalls: 0,
  error: Object.assign(new Error("late cwd verification EIO"), { code: "EIO" }),
  removals: [] as string[],
}));
vi.mock("../../src/state/files.ts", async (original) => {
  const actual = await original<typeof import("../../src/state/files.ts")>();
  return {
    ...actual,
    secureMkdir: (...args: Parameters<typeof actual.secureMkdir>) => {
      actual.secureMkdir(...args);
      if (args[0] === fault.sessions) fault.sessionsMade = true;
    },
  };
});
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    realpathSync: Object.assign((path: string) => actual.realpathSync(path), {
      native: (path: string) => {
        if (path === fault.cwd && fault.sessionsMade) {
          fault.lateCalls += 1;
          throw fault.error;
        }
        return actual.realpathSync.native(path);
      },
    }),
    rmdirSync: (...args: Parameters<typeof actual.rmdirSync>) => {
      fault.removals.push(String(args[0]));
      return actual.rmdirSync(...args);
    },
  };
});
afterEach(() =>
  Object.assign(fault, {
    cwd: "",
    sessions: "",
    sessionsMade: false,
    lateCalls: 0,
    removals: [],
  }),
);

test.runIf(process.platform === "darwin")(
  "C-STATE-14 late verification removes canonical parents after raw-alias children",
  () => {
    expect(fs.lstatSync("/tmp").isSymbolicLink()).toBe(true);
    const cwd = fs.mkdtempSync("/tmp/elwood-state-alias-order-");
    const canonicalCwd = fs.realpathSync.native(cwd);
    const state = join(cwd, "a", "b");
    const sessions = join(state, "sessions");
    Object.assign(fault, { cwd, sessions });
    try {
      let failure: unknown;
      try {
        prepareStateDir(state, { cwd });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBe(fault.error);
      expect(fault.sessionsMade).toBe(true);
      expect(fault.lateCalls).toBe(1);
      expect(fs.existsSync(sessions)).toBe(false);
      expect(fs.existsSync(state)).toBe(false);
      expect(fs.existsSync(join(cwd, "a"))).toBe(false);
      expect(fault.removals).toEqual([sessions, state, join(canonicalCwd, "a")]);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  },
);

test("C-STATE-14 recreation refreshes removal order after a retry creates the parent", () => {
  const parent = join(tempDir("elwood-recreated-state-"), "parent");
  const child = join(parent, "child");
  fs.mkdirSync(child, { recursive: true });
  const made = new CreatedStateDirectories();
  // The first attempt found the parent already present and created only its child.
  made.record(child);
  fs.rmdirSync(child);
  fs.rmdirSync(parent);
  // A retry must now create both; its child keeps the same map key as before.
  fs.mkdirSync(parent);
  made.record(parent);
  fs.mkdirSync(child);
  made.record(child);
  fault.removals = [];
  expect(made.remove()).toBeUndefined();
  expect(fault.removals).toEqual([child, parent]);
  expect(fs.existsSync(parent)).toBe(false);
});
