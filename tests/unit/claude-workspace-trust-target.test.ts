/** Verify Claude's workspace trust scope with real directories and Git metadata (PRD §5.1). */
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test } from "vitest";
import { resolveClaudeWorkspaceTrustTarget } from "../../src/claude/workspace-trust/target.ts";
import { tempDir } from "../helpers/tmp.ts";

function git(cwd: string, ...args: readonly string[]): void {
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, stdio: "ignore" });
}

function repository(cwd = realpathSync(tempDir())): string {
  git(cwd, "init", "--quiet", "--template=");
  return cwd;
}

test.each([
  "workspace ",
  "workspace\\literal",
])("Claude keeps ordinary folder spelling %s", (name) => {
  const parent = realpathSync(tempDir());
  const path = join(parent, name);
  mkdirSync(path);
  const alias = join(parent, "alias");
  symlinkSync(path, alias);
  expect(resolveClaudeWorkspaceTrustTarget(alias)).toEqual({
    launchPath: path,
    targetPath: path,
    targetScope: "folder",
  });
});

test("a Claude workspace in a Git subfolder trusts the repository root", () => {
  const root = repository();
  const child = join(root, "src");
  mkdirSync(child);
  expect(resolveClaudeWorkspaceTrustTarget(child)).toEqual({
    launchPath: child,
    targetPath: root,
    targetScope: "repository",
  });
});

test("Claude uses the nearest repository and excludes its enclosing repository", () => {
  const enclosing = repository();
  const root = join(enclosing, "nested repository");
  mkdirSync(root);
  repository(root);
  const child = join(root, "src");
  mkdirSync(child);
  expect(resolveClaudeWorkspaceTrustTarget(child)?.targetPath).toBe(root);
});

test("a Claude linked worktree trusts the verified main checkout", () => {
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
  expect(resolveClaudeWorkspaceTrustTarget(child)).toEqual({
    launchPath: child,
    targetPath: root,
    targetScope: "repository",
  });
  const administrativeDir = join(root, ".git", "worktrees", "linked");
  const backlink = join(administrativeDir, "gitdir");
  const marker = join(worktree, ".git");
  writeFileSync(marker, `gitdir: ${relative(worktree, administrativeDir)}\n`);
  writeFileSync(backlink, `${relative(administrativeDir, marker)}\n`);
  expect(resolveClaudeWorkspaceTrustTarget(child)?.targetPath).toBe(root);

  // POSIX normalization accepts this as the same marker, but Claude interprets \ as a separator.
  writeFileSync(backlink, `${worktree}/ambiguous\\component/../.git\n`);
  expect(resolveClaudeWorkspaceTrustTarget(child)).toBeUndefined();

  writeFileSync(backlink, "/elsewhere/.git\n");
  expect(resolveClaudeWorkspaceTrustTarget(child)).toBeUndefined();

  const commonFile = join(administrativeDir, "commondir");
  writeFileSync(commonFile, "\n");
  expect(resolveClaudeWorkspaceTrustTarget(child)).toBeUndefined();
  unlinkSync(commonFile);
  mkdirSync(commonFile);
  expect(resolveClaudeWorkspaceTrustTarget(child)).toBeUndefined();
});

test("an ordinary Git directory pointer keeps trust at its own checkout", () => {
  const parent = realpathSync(tempDir());
  const checkout = join(parent, "checkout");
  mkdirSync(checkout);
  git(checkout, "init", "--quiet", "--template=", "--separate-git-dir", join(parent, "metadata"));
  expect(resolveClaudeWorkspaceTrustTarget(checkout)).toEqual({
    launchPath: checkout,
    targetPath: checkout,
    targetScope: "repository",
  });
});

test("ambiguous nearest Git metadata withholds Claude's target", () => {
  const root = repository();
  const child = join(root, "nested");
  mkdirSync(child);
  writeFileSync(join(child, ".git"), "unrecognized metadata\n");
  expect(resolveClaudeWorkspaceTrustTarget(child)).toBeUndefined();
});

test("absent launch folders have no Claude workspace target", () => {
  expect(resolveClaudeWorkspaceTrustTarget(join(tempDir(), "absent"))).toBeUndefined();
});

test("Claude workspace evidence requires an existing absolute directory", () => {
  expect(resolveClaudeWorkspaceTrustTarget("relative/path")).toBeUndefined();
  const file = join(tempDir(), "ordinary file");
  writeFileSync(file, "");
  expect(resolveClaudeWorkspaceTrustTarget(file)).toBeUndefined();
});

test("a Git marker without a verifiable HEAD withholds Claude's target", () => {
  const directory = tempDir();
  mkdirSync(join(directory, ".git"));
  expect(resolveClaudeWorkspaceTrustTarget(directory)).toBeUndefined();
});

test("Claude scope resolution declines a symbolic Git marker", () => {
  const root = repository();
  const directory = tempDir();
  symlinkSync(join(root, ".git"), join(directory, ".git"));
  expect(resolveClaudeWorkspaceTrustTarget(directory)).toBeUndefined();
});

test.each([
  ["ambiguous whitespace", "gitdir: ../metadata \n"],
  ["multiple lines", "gitdir: ../metadata\nunexpected\n"],
  ["oversized input", `gitdir: ${"x".repeat(4096)}\n`],
])("Claude scope resolution declines a Git pointer with %s", (_, value) => {
  const checkout = tempDir();
  writeFileSync(join(checkout, ".git"), value);
  expect(resolveClaudeWorkspaceTrustTarget(checkout)).toBeUndefined();
});
