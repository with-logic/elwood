/** Exercise bounded Codex Git markers independently of native input (PRD §5.5). */
import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { codexRepositoryTrustRoot } from "../../src/codex/workspace-trust/repository.ts";
import { tempDir } from "../helpers/tmp.ts";

vi.mock("node:fs", { spy: true });

let root: string;
beforeEach(() => {
  root = fs.realpathSync(tempDir("elwood-codex-git-markers-"));
});
afterEach(() => {
  vi.restoreAllMocks();
});

function ordinaryExternalGit() {
  const git = join(root, "worktrees", "metadata");
  const checkout = join(root, "checkout");
  fs.mkdirSync(git, { recursive: true });
  fs.mkdirSync(checkout);
  fs.writeFileSync(join(git, "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(join(checkout, ".git"), `gitdir: ${git}\n`);
  return { git, checkout };
}

test("recognizes an ordinary external Git directory whose parent is named worktrees", () => {
  const { checkout } = ordinaryExternalGit();
  expect(codexRepositoryTrustRoot(checkout)).toEqual({
    path: checkout,
    allowsFolderFallback: true,
  });
});

test.each([
  "gitdir",
  "commondir",
])("rejects an incomplete worktree registration with only %s", (file) => {
  const { git, checkout } = ordinaryExternalGit();
  fs.writeFileSync(join(git, file), "../other\n");
  expect(() => codexRepositoryTrustRoot(checkout)).toThrow();
});

test.each([40, 64])("accepts a detached HEAD with a %i-character object ID", (length) => {
  const git = join(root, ".git");
  fs.mkdirSync(git);
  fs.writeFileSync(join(git, "HEAD"), `${"a".repeat(length)}\n`);
  expect(codexRepositoryTrustRoot(root)).toEqual({ path: root, allowsFolderFallback: false });
});

test("rejects an oversized Git marker before reading its bytes", () => {
  const marker = join(root, ".git");
  fs.writeFileSync(marker, "a".repeat(64 * 1024 + 1));
  vi.mocked(fs.readSync).mockClear();
  vi.mocked(fs.readFileSync).mockClear();
  expect(() => codexRepositoryTrustRoot(root)).toThrow();
  expect(fs.readSync).not.toHaveBeenCalled();
  expect(fs.readFileSync).not.toHaveBeenCalled();
});
