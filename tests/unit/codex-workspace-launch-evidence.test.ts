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
import { createLinkedCheckout, registerWorktree } from "../helpers/codex-trust-worktree.ts";
import { tempDir } from "../helpers/tmp.ts";

let root: string;
beforeEach(() => {
  root = realpathSync.native(tempDir("elwood-launch-evidence-"));
});

function launch(cwd: string) {
  return { agent: "codex" as const, cwd, identity: statSync(cwd, { bigint: true }) };
}

test("retains the exact launch alias and canonical directory", async () => {
  const cwd = join(root, "Project");
  const alias = join(root, "alias");
  mkdirSync(cwd);
  symlinkSync(cwd, alias);
  const evidence = await captureLaunchTrustEvidence(launch(alias));
  expect(evidence.aliases).toEqual([alias, cwd]);
  expect(evidence.targets.map(({ target }) => target.targetPath)).toEqual([alias, cwd]);
  await expect(evidence.isCurrent()).resolves.toBe(true);
});

test("identifies the filesystem spelling even when the caller uses mixed case", async ({
  skip,
}) => {
  const cwd = join(root, "Project");
  const alias = join(root, "project");
  mkdirSync(cwd);
  skip(!existsSync(alias), "Temporary filesystem is case-sensitive");
  expect((await captureLaunchTrustEvidence(launch(alias))).aliases).toEqual([alias, cwd]);
});

test("withholds replaced, deleted, or unidentified launch directories", async () => {
  const cwd = join(root, "project");
  mkdirSync(cwd);
  const checked = launch(cwd);
  const evidence = await captureLaunchTrustEvidence(checked);
  await expect(evidence.isCurrent()).resolves.toBe(true);
  expect((await captureLaunchTrustEvidence({ ...checked, identity: undefined })).targets).toEqual(
    [],
  );
  renameSync(cwd, join(root, "original"));
  mkdirSync(cwd);
  await expect(evidence.isCurrent()).resolves.toBe(false);
  expect((await captureLaunchTrustEvidence(checked)).targets).toEqual([]);
  rmSync(cwd, { recursive: true });
  await expect(evidence.isCurrent()).resolves.toBe(false);
});

test("withholds when folder scope changes after an unchanged cwd becomes a repository", async () => {
  const cwd = join(root, "checkout");
  mkdirSync(cwd);
  const evidence = await captureLaunchTrustEvidence(launch(cwd));
  expect(evidence.targets.map(({ target }) => target)).toEqual([
    { targetPath: cwd, targetScope: "folder" },
  ]);
  mkdirSync(join(cwd, ".git"));
  writeFileSync(join(cwd, ".git", "HEAD"), "ref: refs/heads/main\n");
  await expect(evidence.isCurrent()).resolves.toBe(false);
});

test("withholds after the launch directory moves even when a symlink preserves its inode", async () => {
  const repo = join(root, "repository");
  const cwd = join(repo, "child");
  const moved = join(repo, "moved");
  const alias = join(repo, "alias");
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(cwd);
  symlinkSync(cwd, alias);
  const checked = launch(alias);
  const evidence = await captureLaunchTrustEvidence(checked);
  await expect(evidence.isCurrent()).resolves.toBe(true);

  renameSync(cwd, moved);
  symlinkSync(moved, cwd);

  expect(statSync(cwd, { bigint: true }).ino).toBe(checked.identity.ino);
  expect(statSync(alias, { bigint: true }).ino).toBe(checked.identity.ino);
  await expect(evidence.isCurrent()).resolves.toBe(false);
});

test("retains independently verified lexical and physical repository roots", async () => {
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
  const evidence = await captureLaunchTrustEvidence(launch(alias));
  expect(evidence.targets.map(({ target }) => target.targetPath)).toEqual([lexical, physical]);
  await expect(evidence.isCurrent()).resolves.toBe(true);
});

test("withholds when Git root registration changes without replacing the candidate directories", async () => {
  const { checkout, repo } = createLinkedCheckout(root);
  const alternate = join(root, "project");
  mkdirSync(alternate);
  const evidence = await captureLaunchTrustEvidence(launch(checkout));
  expect(evidence.targets.map(({ target }) => target)).toEqual([
    { targetPath: repo, targetScope: "repository" },
  ]);
  await expect(evidence.isCurrent()).resolves.toBe(true);
  registerWorktree(checkout, alternate);
  await expect(evidence.isCurrent()).resolves.toBe(false);
});

test("withholds an exact Git root whose directory identity or registration changed", async () => {
  const { checkout, repo, slot } = createLinkedCheckout(root);
  const evidence = await captureLaunchTrustEvidence(launch(checkout));
  renameSync(repo, join(root, "original"));
  registerWorktree(checkout, repo);
  await expect(evidence.isCurrent()).resolves.toBe(false);
  const initiallyVerified = await captureLaunchTrustEvidence(launch(checkout));
  rmSync(join(slot, "commondir"));
  await expect(initiallyVerified.isCurrent()).resolves.toBe(false);
  const unverified = await captureLaunchTrustEvidence(launch(checkout));
  expect(unverified.targets).toEqual([]);
  await expect(unverified.isCurrent()).resolves.toBe(false);
});

test("allows a folder fallback and a separately verified checkout disclosure for a gitfile", async () => {
  const repo = join(root, "checkout");
  const cwd = join(repo, "child");
  const git = join(root, "separate");
  mkdirSync(git);
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(repo, ".git"), "gitdir: ../separate\n");
  writeFileSync(join(git, "HEAD"), "ref: refs/heads/main\n");
  const evidence = await captureLaunchTrustEvidence(launch(cwd));
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
  const rootEvidence = await captureLaunchTrustEvidence(launch(repo));
  expect(
    rootEvidence.targets.map(({ target, requiresRepositoryNote }) => ({
      ...target,
      requiresRepositoryNote,
    })),
  ).toEqual([{ targetPath: repo, targetScope: "folder", requiresRepositoryNote: false }]);
  await expect(evidence.isCurrent()).resolves.toBe(true);
  writeFileSync(join(git, "HEAD"), "invalid");
  await expect(evidence.isCurrent()).resolves.toBe(false);
  writeFileSync(join(git, "HEAD"), "ref: refs/heads/main\n");
  rmSync(join(repo, ".git"));
  mkdirSync(join(repo, ".git"));
  writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  await expect(evidence.isCurrent()).resolves.toBe(false);
});
