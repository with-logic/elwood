/** Canonical state identity preserves no-follow rejection before resolving aliases (C-API-20). */
import * as fs from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { canonicalStatePath } from "../../src/state/canonical-path.ts";
import { tempDir } from "../helpers/tmp.ts";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    realpathSync: (path: string) => {
      if (path.endsWith("realpath-denied"))
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      return actual.realpathSync(path);
    },
  };
});

test("C-API-20 canonical identity handles existing roots and absent descendants", () => {
  const root = tempDir();
  expect(canonicalStatePath(root)).toBe(fs.realpathSync(root));
  expect(canonicalStatePath(join(root, "missing", "session"))).toBe(
    join(fs.realpathSync(root), "missing", "session"),
  );
});

test("C-API-20 canonical identity still rejects planted leaf and ancestor symlinks", () => {
  const root = tempDir();
  const alias = join(root, "alias");
  fs.symlinkSync(tempDir(), alias);
  expect(() => canonicalStatePath(alias)).toThrowError(
    expect.objectContaining({ code: "state_corrupt" }),
  );
  expect(() => canonicalStatePath(join(alias, "child"))).toThrowError(
    expect.objectContaining({ code: "state_corrupt" }),
  );
});

test("C-API-20 an unexpected realpath failure never falls back to lexical identity", () => {
  const root = join(tempDir(), "realpath-denied");
  fs.mkdirSync(root);
  expect(() => canonicalStatePath(root)).toThrowError(expect.objectContaining({ code: "EACCES" }));
});
