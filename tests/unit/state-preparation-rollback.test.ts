/** Failed setup preserves shared default state and removes eligible owned directories (PRD §8.1, C-STATE-14). */
import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { elwoodError } from "../../src/core/errors.ts";
import { makeStateDirectory } from "../../src/state/directories.ts";
import { makeStateTree } from "../../src/state/root.ts";
import { prepareStateDir } from "../../src/state/store.ts";
import { tempDir } from "../helpers/tmp.ts";

type FaultMode = "mkdir" | "verify";

const fault = vi.hoisted(() => ({
  sessions: "",
  cwd: "",
  kind: undefined as FaultMode | undefined,
  made: false,
  cleanup: "",
  removals: [] as string[],
  consume: () => {},
}));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  const native = (path: string) => {
    if (path === fault.cwd && fault.made && fault.kind === "verify") {
      fault.kind = undefined;
      fault.sessions = "";
      fault.consume();
      throw Object.assign(new Error("verification refused"), { code: "EACCES" });
    }
    return actual.realpathSync.native(path);
  };
  return {
    ...actual,
    realpathSync: Object.assign((path: string) => actual.realpathSync(path), { native }),
    mkdirSync: (path: string, options?: fs.MakeDirectoryOptions) => {
      if (path === fault.sessions) {
        if (fault.kind === "mkdir")
          throw Object.assign(new Error("setup refused"), { code: "EACCES" });
        fault.made = true;
      }
      return actual.mkdirSync(path, options);
    },
    rmdirSync: (...args: Parameters<typeof actual.rmdirSync>) => {
      fault.removals.push(String(args[0]));
      if (args[0] === fault.cleanup)
        throw Object.assign(new Error("cleanup refused"), { code: "EPERM" });
      return actual.rmdirSync(...args);
    },
  };
});
afterEach(() =>
  Object.assign(fault, {
    sessions: "",
    cwd: "",
    kind: undefined,
    made: false,
    cleanup: "",
    removals: [],
    consume: () => {},
  }),
);

function fixture(kind: FaultMode) {
  const base = tempDir("elwood-state-rollback-");
  const cwd = join(base, "project");
  const state = join(base, "made", "state");
  fs.mkdirSync(cwd);
  Object.assign(fault, { sessions: join(state, "sessions"), cwd, kind });
  return { base, cwd, state };
}

test("C-STATE-14 a failed custom setup removes its empty owned scaffolding", () => {
  const { base, cwd, state } = fixture("mkdir");
  expect(() => prepareStateDir(state, { cwd })).toThrow("setup refused");
  expect(fs.existsSync(join(base, "made"))).toBe(false);
  expect(fs.existsSync(cwd)).toBe(true);
});

test("C-STATE-14 a failed default setup retains its shared root even before publication", () => {
  const { cwd, state } = fixture("mkdir");
  expect(() => prepareStateDir(state, { cwd, isImplicitDefaultStateDir: true })).toThrow(
    "setup refused",
  );
  expect(fs.existsSync(state)).toBe(true);
  expect(fs.existsSync(join(state, ".gitignore"))).toBe(false);
});

test("C-STATE-14 failed verification keeps a complete shared ignore but removes the empty own session", () => {
  const { cwd, state } = fixture("verify");
  expect(() =>
    prepareStateDir(state, { cwd, isImplicitDefaultStateDir: true, elwoodSessionId: "own" }),
  ).toThrow("verification refused");
  expect(fs.readFileSync(join(state, ".gitignore"), "utf8")).toBe("*\n");
  expect(fs.readdirSync(join(state, "sessions"))).toEqual([]);
});

for (const [ownId, otherId] of [
  ["own", undefined],
  [undefined, undefined],
  ["own", "other"],
] as const) {
  test(`C-STATE-14 concurrent accepting setup retains shared state (${ownId}/${otherId})`, () => {
    const { base, cwd, state } = fixture("verify");
    const otherCwd = join(base, "other-project");
    fs.mkdirSync(otherCwd);
    let accepted = false;
    fault.consume = () => {
      prepareStateDir(state, {
        cwd: otherCwd,
        isImplicitDefaultStateDir: true,
        ...(otherId === undefined ? {} : { elwoodSessionId: otherId }),
      });
      accepted = true;
    };
    expect(() =>
      prepareStateDir(state, {
        cwd,
        isImplicitDefaultStateDir: true,
        ...(ownId === undefined ? {} : { elwoodSessionId: ownId }),
      }),
    ).toThrow("verification refused");
    expect(accepted).toBe(true);
    expect(fs.readFileSync(join(state, ".gitignore"), "utf8")).toBe("*\n");
    expect(fs.existsSync(join(state, "sessions"))).toBe(true);
    if (otherId !== undefined) expect(fs.existsSync(join(state, "sessions", otherId))).toBe(true);
    if (ownId !== undefined) expect(fs.existsSync(join(state, "sessions", ownId))).toBe(false);
  });
}

for (const typed of [false, true]) {
  for (const prior of [undefined, "EIO"]) {
    test(`C-STATE-14 ${typed ? "typed" : "native"} setup failure retains first cleanup code ${prior}`, () => {
      const root = tempDir("elwood-state-cleanup-");
      const made = join(root, "made");
      const child = join(made, "child");
      const details = prior === undefined ? {} : { cleanupErrorCode: prior };
      const error = typed
        ? elwoodError("state_corrupt", "primary", details)
        : Object.assign(new Error("primary"), details);
      fault.cleanup = child;
      expect(() =>
        makeStateTree(root, (onDirectoryCreated) => {
          makeStateDirectory(child, 0o700, "with-parents", onDirectoryCreated);
          throw error;
        }),
      ).toThrow(
        expect.objectContaining(
          typed
            ? { details: { cleanupErrorCode: prior ?? "EPERM" } }
            : { cleanupErrorCode: prior ?? "EPERM" },
        ),
      );
      expect(fault.removals).toContain(child);
      expect(fault.removals).toContain(made);
    });
  }
}
