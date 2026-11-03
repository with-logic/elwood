/** Entry owners and physical targets retain the shared path policy (C-STATE-11). */
import { chmodSync, mkdirSync, type PathLike, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { assertTrustedIgnoreParent } from "../../../src/state/preparation/root-trust.ts";
import { tempDir } from "../../helpers/tmp.ts";

const owner = vi.hoisted(() => ({ foreign: "", root: "" }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    lstatSync: (path: PathLike) => {
      const info = actual.lstatSync(path);
      if (path === owner.foreign) info.uid = process.getuid!() + 1;
      if (path === owner.root) info.uid = 0;
      return info;
    },
  };
});
afterEach(() => {
  owner.foreign = "";
  owner.root = "";
});

test("C-STATE-11 a foreign-owned link can be replaced by its owner even in a sticky namespace", () => {
  const dir = tempDir("ignore-foreign-link-");
  const target = join(dir, "target");
  mkdirSync(target, { mode: 0o700 });
  const link = join(dir, "alias");
  symlinkSync(target, link);
  owner.foreign = join(realpathSync.native(dir), "alias");
  chmodSync(dir, 0o1777);
  expect(() => assertTrustedIgnoreParent(link)).toThrow(
    expect.objectContaining({ code: "state_corrupt" }),
  );
});

test("C-STATE-11 even a root-owned alias must not bypass an unsafe physical lookup namespace", () => {
  const dir = tempDir("ignore-root-alias-");
  const shared = join(dir, "shared");
  mkdirSync(shared, { mode: 0o777 });
  chmodSync(shared, 0o777);
  const target = join(shared, "target");
  mkdirSync(target, { mode: 0o700 });
  const link = join(dir, "alias");
  symlinkSync(target, link);
  owner.root = join(realpathSync.native(dir), "alias");
  expect(() => assertTrustedIgnoreParent(link)).toThrow(
    expect.objectContaining({ code: "state_corrupt" }),
  );
});
