/** Verify exact Codex launch path and Git evidence independently of terminal output. */
import {
  existsSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import { captureLaunchTrustEvidence } from "../../src/codex/workspace-trust/launch-evidence.ts";
import { registerWorktree } from "../helpers/codex-trust-worktree.ts";
import { tempDir } from "../helpers/tmp.ts";

let root: string;
beforeEach(() => {
  root = realpathSync.native(tempDir("elwood-launch-evidence-"));
});

function launch(cwd: string) {
  return { agent: "codex" as const, cwd, identity: statSync(cwd, { bigint: true }) };
}

function testWorktree() {
  const checkout = join(root, "checkout");
  const repo = join(root, "project ");
  mkdirSync(checkout);
  const registration = registerWorktree(checkout, repo);
  return { checkout, repo, ...registration };
}

test("retains the exact launch alias and canonical directory", () => {
  const cwd = join(root, "Project");
  const alias = join(root, "alias");
  mkdirSync(cwd);
  symlinkSync(cwd, alias);
  const evidence = captureLaunchTrustEvidence(launch(alias));
  expect(evidence.aliases).toEqual([alias, cwd]);
  expect(evidence.targets.map(({ target }) => target.targetPath)).toEqual([alias, cwd]);
  expect(evidence.isCurrent()).toBe(true);
});

test("identifies the filesystem spelling even when the caller uses mixed case", ({ skip }) => {
  const cwd = join(root, "Project");
  const alias = join(root, "project");
  mkdirSync(cwd);
  skip(!existsSync(alias), "Temporary filesystem is case-sensitive");
  expect(captureLaunchTrustEvidence(launch(alias)).aliases).toEqual([alias, cwd]);
});

test("withholds replaced, deleted, or unidentified launch directories", () => {
  const cwd = join(root, "project");
  mkdirSync(cwd);
  const checked = launch(cwd);
  const evidence = captureLaunchTrustEvidence(checked);
  expect(evidence.isCurrent()).toBe(true);
  expect(captureLaunchTrustEvidence({ ...checked, identity: undefined }).targets).toEqual([]);
  renameSync(cwd, join(root, "original"));
  mkdirSync(cwd);
  expect(evidence.isCurrent()).toBe(false);
  expect(captureLaunchTrustEvidence(checked).targets).toEqual([]);
  rmSync(cwd, { recursive: true });
  expect(evidence.isCurrent()).toBe(false);
});

test("withholds when folder scope changes after an unchanged cwd becomes a repository", () => {
  const cwd = join(root, "checkout");
  mkdirSync(cwd);
  const evidence = captureLaunchTrustEvidence(launch(cwd));
  expect(evidence.targets.map(({ target }) => target)).toEqual([
    { targetPath: cwd, targetScope: "folder" },
  ]);
  mkdirSync(join(cwd, ".git"));
  writeFileSync(join(cwd, ".git", "HEAD"), "ref: refs/heads/main\n");
  expect(evidence.isCurrent()).toBe(false);
});

test("withholds after the launch directory moves even when a symlink preserves its inode", () => {
  const repo = join(root, "repository");
  const cwd = join(repo, "child");
  const moved = join(repo, "moved");
  const alias = join(repo, "alias");
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(cwd);
  symlinkSync(cwd, alias);
  const checked = launch(alias);
  const evidence = captureLaunchTrustEvidence(checked);
  expect(evidence.isCurrent()).toBe(true);

  renameSync(cwd, moved);
  symlinkSync(moved, cwd);

  expect(statSync(cwd, { bigint: true }).ino).toBe(checked.identity.ino);
  expect(statSync(alias, { bigint: true }).ino).toBe(checked.identity.ino);
  expect(evidence.isCurrent()).toBe(false);
});

test("retains independently verified lexical and physical repository roots", () => {
  const lexical = join(root, "left");
  const physical = join(root, "right");
  const actual = join(physical, "child");
  const alias = join(lexical, "alias");
  for (const repo of [lexical, physical]) {
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  }
  mkdirSync(actual);
  symlinkSync(actual, alias);
  const evidence = captureLaunchTrustEvidence(launch(alias));
  expect(evidence.targets.map(({ target }) => target.targetPath)).toEqual([lexical, physical]);
  expect(evidence.isCurrent()).toBe(true);
});

test("withholds when Git root registration changes without replacing the candidate directories", () => {
  const { checkout, repo } = testWorktree();
  const alternate = join(root, "project");
  mkdirSync(alternate);
  const evidence = captureLaunchTrustEvidence(launch(checkout));
  expect(evidence.targets.map(({ target }) => target)).toEqual([
    { targetPath: repo, targetScope: "repository" },
  ]);
  expect(evidence.isCurrent()).toBe(true);
  registerWorktree(checkout, alternate);
  expect(evidence.isCurrent()).toBe(false);
});

test("withholds an exact Git root whose directory identity or registration changed", () => {
  const { checkout, repo, slot } = testWorktree();
  const evidence = captureLaunchTrustEvidence(launch(checkout));
  renameSync(repo, join(root, "original"));
  registerWorktree(checkout, repo);
  expect(evidence.isCurrent()).toBe(false);
  const initiallyVerified = captureLaunchTrustEvidence(launch(checkout));
  rmSync(join(slot, "commondir"));
  expect(initiallyVerified.isCurrent()).toBe(false);
  const unverified = captureLaunchTrustEvidence(launch(checkout));
  expect(unverified.targets).toEqual([]);
  expect(unverified.isCurrent()).toBe(false);
});

test("allows a folder fallback and a separately verified checkout disclosure for a gitfile", () => {
  const repo = join(root, "checkout");
  const cwd = join(repo, "child");
  const git = join(root, "separate");
  mkdirSync(git);
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(repo, ".git"), "gitdir: ../separate\n");
  writeFileSync(join(git, "HEAD"), "ref: refs/heads/main\n");
  const evidence = captureLaunchTrustEvidence(launch(cwd));
  expect(
    evidence.targets.map(({ target, requiresRepositoryNote }) => ({
      path: target.targetPath,
      scope: target.targetScope,
      requiresRepositoryNote,
    })),
  ).toEqual([
    { path: cwd, scope: "folder", requiresRepositoryNote: false },
    { path: repo, scope: "repository", requiresRepositoryNote: true },
  ]);
  expect(captureLaunchTrustEvidence(launch(repo)).targets).toHaveLength(1);
  expect(evidence.isCurrent()).toBe(true);
  writeFileSync(join(git, "HEAD"), "invalid");
  expect(evidence.isCurrent()).toBe(false);
  writeFileSync(join(git, "HEAD"), "ref: refs/heads/main\n");
  rmSync(join(repo, ".git"));
  mkdirSync(join(repo, ".git"));
  writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  expect(evidence.isCurrent()).toBe(false);
});
