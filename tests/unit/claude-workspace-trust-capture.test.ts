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
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import {
  captureClaudeWorkspaceTrustTarget,
  resolveClaudeWorkspaceTrustTarget,
} from "../../src/claude/workspace-trust/target.ts";
import { tempDir } from "../helpers/tmp.ts";

vi.mock("node:fs", { spy: true });

function capture(cwd: string) {
  return captureClaudeWorkspaceTrustTarget({
    agent: "claude",
    cwd,
    identity: statSync(cwd, { bigint: true }),
  });
}

test("Claude workspace evidence requires a checked launch identity", () => {
  const readTarget = captureClaudeWorkspaceTrustTarget({
    agent: "claude",
    cwd: tempDir(),
    identity: undefined,
  });
  expect(readTarget()).toBeUndefined();
});

test("Claude workspace evidence requires resolvable Git metadata", () => {
  const cwd = realpathSync(tempDir());
  writeFileSync(join(cwd, ".git"), "unrecognized metadata\n");
  expect(capture(cwd)()).toBeUndefined();
});

test("moving the checked launch directory revokes its scope", () => {
  const parent = realpathSync(tempDir());
  const cwd = join(parent, "checked");
  mkdirSync(cwd);
  const readTarget = capture(cwd);
  renameSync(cwd, join(parent, "moved"));
  expect(readTarget()).toBeUndefined();
});

test.each([
  {
    kind: "file",
    create: () => {
      const file = join(tempDir(), "file");
      writeFileSync(file, "");
      return file;
    },
  },
  { kind: "directory", create: tempDir },
])("replacing the checked target with another $kind revokes scope", async ({ create }) => {
  const replacement = lstatSync(create(), { bigint: true });
  const cwd = realpathSync(tempDir());
  const readTarget = capture(cwd);
  expect(readTarget()).toEqual({
    physicalLaunchPath: cwd,
    targetPath: cwd,
    targetScope: "folder",
  });

  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const mock = vi.mocked(lstatSync).mockImplementation((path, options) => {
    if (path === cwd && options?.bigint === true) return replacement;
    return actual.lstatSync(path, options);
  });
  try {
    expect(readTarget()).toBeUndefined();
  } finally {
    mock.mockRestore();
  }
  expect(readTarget()).toBeUndefined();
});

test("a Git scope change revokes proof even with the same directory identity", () => {
  const cwd = realpathSync(tempDir());
  const readTarget = capture(cwd);
  const gitDirectory = join(cwd, ".git");
  const head = join(gitDirectory, "HEAD");
  mkdirSync(gitDirectory);
  writeFileSync(head, "ref: refs/heads/main\n");
  expect(readTarget()).toBeUndefined();
  unlinkSync(head);
  renameSync(gitDirectory, join(cwd, "previous-git"));
  expect(readTarget()).toBeUndefined();
});

test("a launch directory replaced during verification revokes proof", async () => {
  const parent = realpathSync(tempDir());
  const cwd = join(parent, "checked");
  mkdirSync(cwd);
  mkdirSync(join(parent, ".git"));
  writeFileSync(join(parent, ".git", "HEAD"), "ref: refs/heads/main\n");
  const readTarget = capture(cwd);
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  let changed = false;
  const mock = vi.mocked(statSync).mockImplementation((path, options) => {
    const info = actual.statSync(path, options);
    if (path === cwd && options?.bigint === true && !changed) {
      changed = true;
      renameSync(cwd, join(parent, "former"));
      mkdirSync(cwd);
    }
    return info;
  });
  try {
    expect(readTarget()).toBeUndefined();
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
  expect(capture(alias)()?.physicalLaunchPath).toBe(original);
  const identity = statSync(alias, { bigint: true });
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const repoint = (target: string) => {
    unlinkSync(alias);
    symlinkSync(target, alias);
  };
  const mock = vi.mocked(statSync).mockImplementation((path, options) => {
    const info = actual.statSync(path, options);
    if (path === alias && info?.ino === identity.ino) repoint(replacement);
    return info;
  });
  try {
    const readTarget = captureClaudeWorkspaceTrustTarget({ agent: "claude", cwd: alias, identity });
    repoint(original);
    expect(readTarget()).toBeUndefined();
  } finally {
    mock.mockRestore();
  }
});

test("replacing a linked worktree's main checkout revokes its captured target", () => {
  const parent = realpathSync(tempDir());
  const root = join(parent, "main");
  const worktree = join(parent, "linked");
  const common = join(root, ".git");
  const administrative = join(common, "worktrees", "linked");
  mkdirSync(administrative, { recursive: true });
  mkdirSync(worktree);
  writeFileSync(join(common, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(administrative, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(administrative, "commondir"), "../..\n");
  writeFileSync(join(administrative, "gitdir"), join(worktree, ".git"));
  writeFileSync(join(worktree, ".git"), `gitdir: ${administrative}\n`);
  const target = { physicalLaunchPath: worktree, targetPath: root, targetScope: "repository" };
  const readTarget = capture(worktree);
  expect(readTarget()).toEqual(target);

  const former = join(parent, "former-main");
  renameSync(root, former);
  mkdirSync(root);
  renameSync(join(former, ".git"), common);
  expect(resolveClaudeWorkspaceTrustTarget(worktree)).toEqual(target);
  expect(readTarget()).toBeUndefined();

  renameSync(common, join(former, ".git"));
  renameSync(root, join(parent, "replacement"));
  renameSync(former, root);
  expect(resolveClaudeWorkspaceTrustTarget(worktree)).toEqual(target);
  expect(readTarget()).toBeUndefined();
});
