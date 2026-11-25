/** Exercise the private Git scope proof for a checked launch directory (PRD §5.1). */
import {
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { lstat, stat } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { captureClaudeLaunchTrustEvidence } from "../../src/claude/workspace-trust/target.ts";
import { tempDir } from "../helpers/tmp.ts";

vi.mock("node:fs/promises", { spy: true });

async function capture(cwd: string) {
  const captured = await captureClaudeLaunchTrustEvidence({
    agent: "claude",
    cwd,
    identity: statSync(cwd, { bigint: true }),
  });
  if (!captured) throw new Error("Expected checked workspace evidence.");
  return captured;
}

test("Claude workspace evidence requires a checked launch identity", async () => {
  const captured = await captureClaudeLaunchTrustEvidence({
    agent: "claude",
    cwd: tempDir(),
    identity: undefined,
  });
  expect(captured).toBeUndefined();
});

test("Claude workspace evidence requires resolvable Git metadata", async () => {
  const cwd = realpathSync(tempDir());
  writeFileSync(join(cwd, ".git"), "unrecognized metadata\n");
  const identity = statSync(cwd, { bigint: true });
  expect(
    await captureClaudeLaunchTrustEvidence({ agent: "claude", cwd, identity }),
  ).toBeUndefined();
});

test.each([
  false,
  true,
])("moving the checked launch folder revokes its scope (replacement: %s)", async (replace) => {
  const parent = realpathSync(tempDir());
  const cwd = join(parent, "checked");
  mkdirSync(cwd);
  const { isCurrent } = await capture(cwd);
  renameSync(cwd, join(parent, "moved"));
  if (replace) mkdirSync(cwd);
  expect(await isCurrent()).toBe(false);
});

test.each([
  "file",
  "directory",
])("replacing the checked target with another %s revokes scope", async (kind) => {
  const cwd = realpathSync(tempDir());
  const { isCurrent, scope } = await capture(cwd);
  expect(scope).toEqual({ physicalLaunchPath: cwd, targetPath: cwd, targetScope: "folder" });

  const directory = tempDir();
  const file = join(directory, "file");
  writeFileSync(file, "");
  const replacement = lstatSync(kind === "file" ? file : directory, { bigint: true });
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const mock = vi.mocked(lstat).mockImplementation((...args) => {
    if (args[0] === cwd && args[1]?.bigint === true) return Promise.resolve(replacement);
    return Reflect.apply(actual.lstat, undefined, args);
  });
  try {
    expect(await isCurrent()).toBe(false);
  } finally {
    mock.mockRestore();
  }
  expect(await isCurrent()).toBe(false);
});

test("a Git scope change revokes proof even with the same directory identity", async () => {
  const cwd = realpathSync(tempDir());
  const { isCurrent } = await capture(cwd);
  const gitDirectory = join(cwd, ".git");
  const head = join(gitDirectory, "HEAD");
  mkdirSync(gitDirectory);
  writeFileSync(head, "ref: refs/heads/main\n");
  expect(await isCurrent()).toBe(false);
  unlinkSync(head);
  renameSync(gitDirectory, join(cwd, "previous-git"));
  expect(await isCurrent()).toBe(false);
});

test("a launch directory replaced during verification revokes proof", async () => {
  const parent = realpathSync(tempDir());
  const cwd = join(parent, "checked");
  mkdirSync(cwd);
  mkdirSync(join(parent, ".git"));
  writeFileSync(join(parent, ".git", "HEAD"), "ref: refs/heads/main\n");
  const { isCurrent } = await capture(cwd);
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  let changed = false;
  const mock = vi.mocked(stat).mockImplementation(async (...args) => {
    const info = await Reflect.apply(actual.stat, undefined, args);
    if (args[0] === cwd && args[1]?.bigint === true && !changed) {
      changed = true;
      renameSync(cwd, join(parent, "former"));
      mkdirSync(cwd);
    }
    return info;
  });
  try {
    expect(await isCurrent()).toBe(false);
    expect(changed).toBe(true);
  } finally {
    mock.mockRestore();
  }
});

test("a launch alias retargeted after the identity read cannot establish proof", async () => {
  const parent = realpathSync(tempDir());
  const original = join(parent, "original");
  const replacement = join(parent, "replacement");
  const alias = join(parent, "alias");
  mkdirSync(original);
  mkdirSync(replacement);
  symlinkSync(original, alias);
  expect((await capture(alias)).scope.physicalLaunchPath).toBe(original);
  const identity = statSync(alias, { bigint: true });
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const repoint = (target: string) => {
    unlinkSync(alias);
    symlinkSync(target, alias);
  };
  const mock = vi.mocked(stat).mockImplementation(async (...args) => {
    const info = await Reflect.apply(actual.stat, undefined, args);
    if (args[0] === alias && info?.ino === identity.ino) repoint(replacement);
    return info;
  });
  try {
    expect(
      await captureClaudeLaunchTrustEvidence({ agent: "claude", cwd: alias, identity }),
    ).toBeUndefined();
  } finally {
    mock.mockRestore();
  }
});

test("a launch alias retargeted after verifying its physical directory revokes proof", async () => {
  const parent = realpathSync(tempDir());
  const original = join(parent, "original");
  const replacement = join(parent, "replacement");
  const alias = join(parent, "alias");
  mkdirSync(original);
  mkdirSync(replacement);
  symlinkSync(original, alias);
  const { isCurrent } = await capture(alias);
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const mock = vi.mocked(stat).mockImplementation(async (...args) => {
    const info = await Reflect.apply(actual.stat, undefined, args);
    if (args[0] === original) {
      unlinkSync(alias);
      symlinkSync(replacement, alias);
    }
    return info;
  });
  try {
    expect(await isCurrent()).toBe(false);
  } finally {
    mock.mockRestore();
  }
});
