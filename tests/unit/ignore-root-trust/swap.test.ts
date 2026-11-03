/** A shared namespace cannot redirect staging into an outside directory (C-STATE-11). */
import * as fs from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { assertStatePath } from "../../../src/state/directories.ts";
import { installDefaultIgnore } from "../../../src/state/preparation/install-ignore.ts";
import { assertTrustedIgnoreParent } from "../../../src/state/preparation/root-trust.ts";
import { tempDir } from "../../helpers/tmp.ts";

const race = vi.hoisted(() => ({ stage: undefined as (() => void) | undefined }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      if (typeof args[0] === "string" && args[0].endsWith(".pending")) race.stage?.();
      return actual.openSync(...args);
    },
  };
});
afterEach(() => {
  race.stage = undefined;
});

function guardedInstall(path: string): void {
  assertStatePath(dirname(path)); // The existing no-symlink check passes before the controlled swap.
  assertTrustedIgnoreParent(dirname(path));
  installDefaultIgnore(path);
}

test("C-STATE-11 shared-writable parent is rejected before an attacker can swap .elwood at staging", () => {
  const dir = tempDir("ignore-shared-swap-");
  fs.chmodSync(dir, 0o700);
  const shared = join(dir, "shared");
  fs.mkdirSync(shared);
  fs.chmodSync(shared, 0o777);
  const state = join(shared, ".elwood");
  fs.mkdirSync(state, { mode: 0o755 });
  const outside = join(dir, "outside");
  fs.mkdirSync(outside, { mode: 0o700 });
  const victim = join(outside, "victim");
  fs.writeFileSync(victim, "protected", { mode: 0o600 });
  let swapped = false;
  race.stage = () => {
    race.stage = undefined;
    fs.renameSync(state, join(shared, "saved"));
    fs.symlinkSync(outside, state);
    swapped = true;
  };
  let failure: unknown;
  try {
    guardedInstall(join(state, ".gitignore"));
  } catch (error) {
    failure = error;
  }
  expect(fs.readFileSync(victim, "utf8")).toBe("protected");
  expect(fs.statSync(victim).mode & 0o777).toBe(0o600);
  expect(fs.existsSync(join(outside, ".gitignore"))).toBe(false);
  expect(failure).toMatchObject({ code: "state_corrupt" });
  expect(swapped).toBe(false);
});

test("C-STATE-11 a normal private namespace installs only its own ignore", () => {
  const dir = tempDir("ignore-private-control-");
  fs.chmodSync(dir, 0o700);
  const state = join(dir, ".elwood");
  fs.mkdirSync(state, { mode: 0o755 });
  const target = join(state, ".gitignore");
  guardedInstall(target);
  expect(fs.readFileSync(target, "utf8")).toBe("*\n");
  expect(fs.statSync(target).mode & 0o777).toBe(0o644);
  expect(fs.readdirSync(state)).toEqual([basename(target)]);
});
