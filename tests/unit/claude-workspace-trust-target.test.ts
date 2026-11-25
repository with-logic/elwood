/** Verify Claude's workspace trust scope with real directories and Git metadata (PRD §5.1). */
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test } from "vitest";
import { resolveClaudeWorkspaceTrustTarget } from "../../src/claude/workspace-trust/target.ts";
import { tempDir } from "../helpers/tmp.ts";

function git(cwd: string, ...args: readonly string[]): void {
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    stdio: "ignore",
    env: {
      PATH: process.env["PATH"],
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });
}

function repository(cwd = realpathSync(tempDir())): string {
  git(cwd, "init", "--quiet", "--template=");
  return cwd;
}

test.each([
  "workspace ",
  "workspace\\literal",
])("Claude keeps ordinary folder spelling %s", async (name) => {
  const parent = realpathSync(tempDir());
  const path = join(parent, name);
  mkdirSync(path);
  const alias = join(parent, "alias");
  symlinkSync(path, alias);
  expect(await resolveClaudeWorkspaceTrustTarget(alias)).toEqual({
    physicalLaunchPath: path,
    targetPath: path,
    targetScope: "folder",
  });
});

test("a Claude workspace in a Git subfolder resolves the repository root", async () => {
  const root = repository();
  const child = join(root, "src");
  mkdirSync(child);
  expect(await resolveClaudeWorkspaceTrustTarget(child)).toEqual({
    physicalLaunchPath: child,
    targetPath: root,
    targetScope: "repository",
  });
});

test("Claude uses the nearest repository and excludes its enclosing repository", async () => {
  const enclosing = repository();
  const root = join(enclosing, "nested repository");
  mkdirSync(root);
  repository(root);
  const child = join(root, "src");
  mkdirSync(child);
  expect((await resolveClaudeWorkspaceTrustTarget(child))?.targetPath).toBe(root);
});

test("a Claude linked worktree resolves the registered main checkout", async () => {
  const parent = realpathSync(tempDir());
  const root = join(parent, "main repository");
  mkdirSync(root);
  repository(root);
  git(
    root,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "--no-gpg-sign",
    "--allow-empty",
    "--quiet",
    "-m",
    "initial",
  );
  const worktree = join(parent, "linked");
  git(root, "worktree", "add", "--quiet", "--detach", worktree);
  const child = join(worktree, "src");
  mkdirSync(child);
  expect(await resolveClaudeWorkspaceTrustTarget(child)).toEqual({
    physicalLaunchPath: child,
    targetPath: root,
    targetScope: "repository",
  });
  const mainHead = join(root, ".git", "HEAD");
  writeFileSync(mainHead, "not a Git HEAD");
  expect(await resolveClaudeWorkspaceTrustTarget(child)).toBeUndefined();
  writeFileSync(mainHead, "ref: refs/heads/main\n");

  const administrativeDir = join(root, ".git", "worktrees", "linked");
  const backlink = join(administrativeDir, "gitdir");
  const marker = join(worktree, ".git");
  writeFileSync(marker, `gitdir: ${relative(worktree, administrativeDir)}\n`);
  writeFileSync(backlink, `${relative(administrativeDir, marker)}\n`);
  expect((await resolveClaudeWorkspaceTrustTarget(child))?.targetPath).toBe(root);

  // POSIX normalization accepts this as the same marker, but Claude interprets \ as a separator.
  writeFileSync(backlink, `${worktree}/ambiguous\\component/../.git\n`);
  expect(await resolveClaudeWorkspaceTrustTarget(child)).toBeUndefined();

  writeFileSync(backlink, `${join(root, ".git")}\n`);
  expect(await resolveClaudeWorkspaceTrustTarget(child)).toBeUndefined();

  writeFileSync(backlink, `${worktree}/missing/../.git\n`);
  expect(await resolveClaudeWorkspaceTrustTarget(child)).toBeUndefined();
  writeFileSync(backlink, `${relative(administrativeDir, marker)}\n`);

  const commonFile = join(administrativeDir, "commondir");
  unlinkSync(commonFile);
  expect(await resolveClaudeWorkspaceTrustTarget(child)).toBeUndefined();
  writeFileSync(commonFile, "\n");
  expect(await resolveClaudeWorkspaceTrustTarget(child)).toBeUndefined();
  unlinkSync(commonFile);
  mkdirSync(commonFile);
  expect(await resolveClaudeWorkspaceTrustTarget(child)).toBeUndefined();
});

test("an ordinary Git directory pointer keeps trust at its own checkout", async () => {
  const parent = realpathSync(tempDir());
  const checkout = join(parent, "checkout");
  mkdirSync(checkout);
  git(checkout, "init", "--quiet", "--template=", "--separate-git-dir", join(parent, "metadata"));
  expect(await resolveClaudeWorkspaceTrustTarget(checkout)).toEqual({
    physicalLaunchPath: checkout,
    targetPath: checkout,
    targetScope: "repository",
  });
  const alias = join(parent, "metadata-alias");
  symlinkSync(join(parent, "metadata"), alias);
  writeFileSync(join(checkout, ".git"), `gitdir: ${alias}\n`);
  expect(await resolveClaudeWorkspaceTrustTarget(checkout)).toBeUndefined();
});

test("ambiguous nearest Git metadata withholds Claude's target", async () => {
  const root = repository();
  const child = join(root, "nested");
  mkdirSync(child);
  writeFileSync(join(child, ".git"), "unrecognized metadata\n");
  expect(await resolveClaudeWorkspaceTrustTarget(child)).toBeUndefined();
});

test("absent launch folders have no Claude workspace target", async () => {
  expect(await resolveClaudeWorkspaceTrustTarget(join(tempDir(), "absent"))).toBeUndefined();
});

test("Claude workspace evidence requires an existing absolute directory", async () => {
  expect(await resolveClaudeWorkspaceTrustTarget("relative/path")).toBeUndefined();
  const file = join(tempDir(), "ordinary file");
  writeFileSync(file, "");
  expect(await resolveClaudeWorkspaceTrustTarget(file)).toBeUndefined();
});

test.each([
  ["missing", undefined],
  ["empty", ""],
  ["malformed", "not Git metadata"],
  ["oversized", `ref: refs/heads/${"a".repeat(4096)}`],
])("a %s Git HEAD withholds Claude's target", async (_, contents) => {
  const directory = tempDir();
  mkdirSync(join(directory, ".git"));
  if (contents !== undefined) writeFileSync(join(directory, ".git", "HEAD"), contents);
  expect(await resolveClaudeWorkspaceTrustTarget(directory)).toBeUndefined();
});

test("Claude scope resolution declines a symbolic Git marker", async () => {
  const root = repository();
  const directory = tempDir();
  symlinkSync(join(root, ".git"), join(directory, ".git"));
  expect(await resolveClaudeWorkspaceTrustTarget(directory)).toBeUndefined();
});

test.each([
  "metadata ",
  "metadata\nother",
])("a Git pointer with ambiguous directory spelling %s withholds scope", async (name) => {
  const parent = realpathSync(tempDir());
  const checkout = join(parent, "checkout");
  const gitDirectory = join(parent, name);
  mkdirSync(checkout);
  mkdirSync(gitDirectory);
  writeFileSync(join(gitDirectory, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(checkout, ".git"), `gitdir: ${gitDirectory}\n`);
  expect(await resolveClaudeWorkspaceTrustTarget(checkout)).toBeUndefined();
});
