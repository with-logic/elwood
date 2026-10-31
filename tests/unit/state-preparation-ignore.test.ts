/** Ownership and failure paths for startup scaffolding undo (C-STATE-14, PRD §8.1). */
import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createDefaultIgnore } from "../../src/state/preparation/ignore.ts";
import { prepareStateDir } from "../../src/state/preparation/index.ts";
import { makeStateTree } from "../../src/state/root.ts";
import { tempDir } from "../helpers/tmp.ts";

const failure = vi.hoisted(() => ({ operation: "", code: "" }));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  const fail = (operation: string) => {
    if (failure.operation === operation)
      throw Object.assign(new Error(operation), { code: failure.code });
  };
  return {
    ...actual,
    mkdirSync: (path: string, options?: fs.MakeDirectoryOptions) => {
      if (failure.operation === "mkdir" && path.endsWith("/sessions")) {
        failure.operation = "";
        throw Object.assign(new Error("mkdir"), { code: "ENOENT" });
      }
      return actual.mkdirSync(path, options);
    },
    readdirSync: (path: string) => {
      fail("read");
      return actual.readdirSync(path);
    },
    unlinkSync: (path: string) => {
      fail("unlink");
      return actual.unlinkSync(path);
    },
  };
});
afterEach(() => {
  failure.operation = "";
});

function fixture() {
  const root = tempDir("elwood-ignore-undo-");
  const path = join(root, ".gitignore");
  const sessions = join(root, "sessions");
  return { root, path, sessions };
}

test("C-STATE-14 exclusive ignore creation preserves an existing user file", () => {
  const { path, sessions } = fixture();
  fs.writeFileSync(path, "keep");
  expect(createDefaultIgnore(path, sessions, undefined)).toBeUndefined();
  expect(fs.readFileSync(path, "utf8")).toBe("keep");
});

test("C-STATE-14 ignore creation propagates a missing parent", () => {
  const { root, sessions } = fixture();
  expect(() => createDefaultIgnore(join(root, "missing", "ignore"), sessions, undefined)).toThrow(
    expect.objectContaining({ code: "ENOENT" }),
  );
});

for (const layout of [
  "missing sessions",
  "own session",
  "other session",
  "changed inode",
  "missing ignore",
] as const) {
  test(`C-STATE-14 ignore undo handles ${layout}`, () => {
    const { path, sessions } = fixture();
    const undo = createDefaultIgnore(path, sessions, "own");
    if (layout !== "missing sessions") fs.mkdirSync(sessions);
    if (layout === "own session" || layout === "other session")
      fs.mkdirSync(join(sessions, layout === "own session" ? "own" : "other"));
    if (layout === "changed inode") {
      fs.renameSync(path, `${path}.old`);
      fs.writeFileSync(path, "keep");
    }
    if (layout === "missing ignore") fs.unlinkSync(path);
    undo?.();
    expect(fs.existsSync(path)).toBe(layout === "other session" || layout === "changed inode");
  });
}

for (const operation of ["read", "unlink"] as const) {
  for (const code of ["ENOENT", "EACCES"] as const) {
    test(`C-STATE-14 ignore undo ${operation} preserves ${code} semantics`, () => {
      const { path, sessions } = fixture();
      fs.mkdirSync(sessions);
      const undo = createDefaultIgnore(path, sessions, "own");
      Object.assign(failure, { operation, code });
      if (code === "ENOENT") expect(undo).not.toThrow();
      else expect(undo).toThrow(expect.objectContaining({ code }));
    });
  }
}

test("C-STATE-14 setup retains its first ignore undo when retry finds that file", () => {
  const { root } = fixture();
  // The first failed mkdir is retried without replacing the already-owned ignore.
  failure.operation = "mkdir";
  let checks = 0;
  expect(() =>
    prepareStateDir(root, {
      cwd: root,
      isImplicitDefaultStateDir: true,
      assertCwdUnchanged: () => {
        checks += 1;
        if (checks === 4) throw new Error("changed");
      },
    }),
  ).toThrow("changed");
  expect(fs.existsSync(join(root, ".gitignore"))).toBe(false);
});

test("C-STATE-14 a file undo failure still attempts directory cleanup", () => {
  const root = tempDir("elwood-undo-failure-");
  const made = join(root, "made");
  expect(() =>
    makeStateTree(
      root,
      made,
      () => {
        fs.mkdirSync(made);
        throw new Error("start");
      },
      undefined,
      () => {
        throw Object.assign(new Error("undo"), { code: "EACCES" });
      },
    ),
  ).toThrow(expect.objectContaining({ message: "start", cleanupErrorCode: "EACCES" }));
  expect(fs.existsSync(made)).toBe(false);
});
